#!/usr/bin/env python3
"""Fine-tune a Whisper model on Afrikaans audio data."""

import argparse
import csv
import logging
import os
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Dict, List, Union

import torch
import evaluate as hf_evaluate
from datasets import Audio, Dataset, DatasetDict, concatenate_datasets, load_dataset
from transformers import (
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def parse_args():
    p = argparse.ArgumentParser(description="Fine-tune Whisper for Afrikaans")
    p.add_argument("--model_name", default=os.environ.get("WHISPER_MODEL", "openai/whisper-small"))
    p.add_argument("--output_dir", default=os.environ.get("OUTPUT_DIR", "./output"))
    p.add_argument("--custom_data_dir", default=os.environ.get("CUSTOM_DATA_DIR"))
    p.add_argument("--language", default=os.environ.get("CV_LANGUAGE", "af"))
    p.add_argument("--hf_token", default=os.environ.get("HF_TOKEN"))
    p.add_argument("--num_train_epochs", type=int, default=int(os.environ.get("NUM_TRAIN_EPOCHS", "3")))
    p.add_argument("--per_device_train_batch_size", type=int, default=int(os.environ.get("PER_DEVICE_TRAIN_BATCH_SIZE", "4")))
    p.add_argument("--per_device_eval_batch_size", type=int, default=2)
    p.add_argument("--learning_rate", type=float, default=float(os.environ.get("LEARNING_RATE", "1e-5")))
    p.add_argument("--warmup_steps", type=int, default=500)
    p.add_argument("--gradient_accumulation_steps", type=int, default=4)
    p.add_argument("--max_steps", type=int, default=-1)
    p.add_argument("--eval_steps", type=int, default=500)
    p.add_argument("--save_steps", type=int, default=500)
    p.add_argument("--logging_steps", type=int, default=25)
    p.add_argument("--resume_from_checkpoint", default=None)
    p.add_argument("--device", default=os.environ.get("DEVICE", "auto"))
    return p.parse_args()


def load_common_voice(language: str, hf_token: str = None) -> DatasetDict:
    """Load Mozilla Common Voice dataset."""
    logger.info("Loading Common Voice dataset for '%s'...", language)
    cv = load_dataset(
        "mozilla-foundation/common_voice_17_0",
        language,
        token=hf_token,
        trust_remote_code=True,
    )
    # Remove unnecessary columns
    remove_cols = [
        "accent", "age", "client_id", "down_votes", "gender",
        "locale", "path", "segment", "up_votes", "variant",
    ]
    for split in cv:
        cols_to_drop = [c for c in remove_cols if c in cv[split].column_names]
        if cols_to_drop:
            cv[split] = cv[split].remove_columns(cols_to_drop)
    logger.info("Common Voice loaded: %s", {k: len(v) for k, v in cv.items()})
    return cv


def load_custom_data(data_dir: str) -> Dataset:
    """
    Load custom audio+transcript pairs from a directory.

    Supports two formats:
    1. CSV manifest: data_dir/transcripts.csv + data_dir/audio/*.wav
       CSV columns: file_name, sentence
    2. Paired files: data_dir/001.wav + data_dir/001.txt
    """
    data_dir = Path(data_dir)
    csv_path = data_dir / "transcripts.csv"
    audio_files = []
    sentences = []

    if csv_path.exists():
        audio_dir = data_dir / "audio"
        with open(csv_path, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                audio_path = audio_dir / row["file_name"]
                if audio_path.exists():
                    audio_files.append(str(audio_path))
                    sentences.append(row["sentence"].strip())
    else:
        # Paired files: 001.wav + 001.txt
        audio_exts = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
        for audio_path in sorted(data_dir.iterdir()):
            if audio_path.suffix.lower() in audio_exts:
                txt_path = audio_path.with_suffix(".txt")
                if txt_path.exists():
                    audio_files.append(str(audio_path))
                    sentences.append(txt_path.read_text(encoding="utf-8").strip())

    if not audio_files:
        logger.warning("No custom data found in %s", data_dir)
        return None

    ds = Dataset.from_dict({"audio": audio_files, "sentence": sentences})
    ds = ds.cast_column("audio", Audio(sampling_rate=16000))
    logger.info("Loaded %d custom samples from %s", len(ds), data_dir)
    return ds


def prepare_dataset(example, processor):
    """Preprocess: audio -> mel spectrogram, text -> token IDs."""
    audio = example["audio"]
    input_features = processor.feature_extractor(
        audio["array"],
        sampling_rate=audio["sampling_rate"],
        return_tensors="np",
    ).input_features[0]
    labels = processor.tokenizer(example["sentence"]).input_ids
    return {"input_features": input_features, "labels": labels}


@dataclass
class DataCollatorSpeechSeq2Seq:
    processor: WhisperProcessor
    decoder_start_token_id: int

    def __call__(self, features: List[Dict[str, Union[List[int], torch.Tensor]]]) -> Dict[str, torch.Tensor]:
        input_features = [{"input_features": f["input_features"]} for f in features]
        batch = self.processor.feature_extractor.pad(input_features, return_tensors="pt")

        label_features = [{"input_ids": f["labels"]} for f in features]
        labels_batch = self.processor.tokenizer.pad(label_features, return_tensors="pt")
        labels = labels_batch["input_ids"].masked_fill(
            labels_batch.attention_mask.ne(1), -100
        )
        if (labels[:, 0] == self.decoder_start_token_id).all().cpu().item():
            labels = labels[:, 1:]

        batch["labels"] = labels
        return batch


def compute_metrics(pred, tokenizer, metric):
    pred_ids = pred.predictions
    label_ids = pred.label_ids
    label_ids[label_ids == -100] = tokenizer.pad_token_id
    pred_str = tokenizer.batch_decode(pred_ids, skip_special_tokens=True)
    label_str = tokenizer.batch_decode(label_ids, skip_special_tokens=True)
    wer = 100 * metric.compute(predictions=pred_str, references=label_str)
    return {"wer": wer}


def main():
    args = parse_args()

    # Detect compute
    if torch.cuda.is_available():
        fp16, bf16, torch_dtype = True, False, torch.float16
        logger.info("CUDA detected. Using fp16.")
    else:
        fp16 = False
        bf16 = hasattr(torch.cpu, "is_bf16_supported") and torch.cpu.is_bf16_supported()
        torch_dtype = torch.bfloat16 if bf16 else torch.float32
        logger.info("CPU training. Using %s.", "bf16" if bf16 else "fp32")

    # Load processor and model
    logger.info("Loading model: %s", args.model_name)
    processor = WhisperProcessor.from_pretrained(
        args.model_name, language="af", task="transcribe"
    )
    model = WhisperForConditionalGeneration.from_pretrained(
        args.model_name, torch_dtype=torch_dtype
    )
    model.generation_config.language = "af"
    model.generation_config.task = "transcribe"
    model.generation_config.forced_decoder_ids = None

    # Load data
    cv = load_common_voice(args.language, args.hf_token)

    if args.custom_data_dir and os.path.isdir(args.custom_data_dir):
        custom_ds = load_custom_data(args.custom_data_dir)
        if custom_ds is not None:
            cv["train"] = concatenate_datasets([cv["train"], custom_ds])
            logger.info("Total training samples: %d", len(cv["train"]))

    # Resample and preprocess
    cv = cv.cast_column("audio", Audio(sampling_rate=16000))
    cv = cv.map(
        partial(prepare_dataset, processor=processor),
        remove_columns=cv["train"].column_names,
        num_proc=1,
    )

    # Training args
    training_args = Seq2SeqTrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.per_device_train_batch_size,
        per_device_eval_batch_size=args.per_device_eval_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        warmup_steps=args.warmup_steps,
        num_train_epochs=args.num_train_epochs,
        max_steps=args.max_steps if args.max_steps > 0 else -1,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        fp16=fp16,
        bf16=bf16,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=3,
        logging_steps=args.logging_steps,
        load_best_model_at_end=True,
        metric_for_best_model="wer",
        greater_is_better=False,
        predict_with_generate=True,
        generation_max_length=225,
        report_to=["none"],
        dataloader_num_workers=0,
        push_to_hub=False,
        remove_unused_columns=False,
    )

    # Trainer
    data_collator = DataCollatorSpeechSeq2Seq(
        processor=processor,
        decoder_start_token_id=model.config.decoder_start_token_id,
    )
    wer_metric = hf_evaluate.load("wer")

    eval_split = "validation" if "validation" in cv else "test"
    trainer = Seq2SeqTrainer(
        model=model,
        args=training_args,
        train_dataset=cv["train"],
        eval_dataset=cv[eval_split],
        data_collator=data_collator,
        compute_metrics=partial(compute_metrics, tokenizer=processor.tokenizer, metric=wer_metric),
        tokenizer=processor.feature_extractor,
    )

    # Train
    logger.info("Starting training (%d epochs, batch=%d, lr=%s)...",
                args.num_train_epochs, args.per_device_train_batch_size, args.learning_rate)
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)

    # Save
    trainer.save_model(args.output_dir)
    processor.save_pretrained(args.output_dir)
    logger.info("Model saved to %s", args.output_dir)


if __name__ == "__main__":
    main()
