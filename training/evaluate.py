#!/usr/bin/env python3
"""Evaluate a Whisper model on the Common Voice Afrikaans test set."""

import argparse
import logging
import os
import tempfile

import evaluate as hf_evaluate
import soundfile as sf
import torch
from datasets import Audio, load_dataset
from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def parse_args():
    p = argparse.ArgumentParser(description="Evaluate Whisper WER on Afrikaans")
    p.add_argument("--model_dir", required=True, help="Path to HF or CTranslate2 model")
    p.add_argument("--model_format", default="hf", choices=["hf", "ctranslate2"])
    p.add_argument("--language", default=os.environ.get("CV_LANGUAGE", "af"))
    p.add_argument("--hf_token", default=os.environ.get("HF_TOKEN"))
    p.add_argument("--batch_size", type=int, default=8)
    p.add_argument("--max_samples", type=int, default=None, help="Limit to N samples for quick checks")
    p.add_argument("--split", default="test", choices=["test", "validation"])
    return p.parse_args()


def load_test_data(language, split, hf_token, max_samples=None):
    cv = load_dataset(
        "mozilla-foundation/common_voice_17_0",
        language, split=split, token=hf_token, trust_remote_code=True,
    )
    cv = cv.cast_column("audio", Audio(sampling_rate=16000))
    if max_samples:
        cv = cv.select(range(min(max_samples, len(cv))))
    return cv


def evaluate_hf(args, test_data):
    processor = WhisperProcessor.from_pretrained(args.model_dir, language="af", task="transcribe")
    model = WhisperForConditionalGeneration.from_pretrained(args.model_dir)
    model.eval()

    pipe = pipeline(
        "automatic-speech-recognition",
        model=model, tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        chunk_length_s=30, batch_size=args.batch_size,
        torch_dtype=torch.float32,
    )

    predictions, references = [], []
    for i, sample in enumerate(test_data):
        result = pipe(sample["audio"]["array"], generate_kwargs={"language": "af", "task": "transcribe"})
        predictions.append(result["text"].strip())
        references.append(sample["sentence"].strip())
        if (i + 1) % 50 == 0:
            logger.info("  %d / %d", i + 1, len(test_data))

    return predictions, references


def evaluate_ct2(args, test_data):
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model_dir, device="cpu", compute_type="int8")

    predictions, references = [], []
    for i, sample in enumerate(test_data):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            sf.write(tmp.name, sample["audio"]["array"], 16000)
            segments, _ = model.transcribe(tmp.name, language="af", beam_size=5)
            text = " ".join(s.text.strip() for s in segments)

        predictions.append(text)
        references.append(sample["sentence"].strip())
        if (i + 1) % 50 == 0:
            logger.info("  %d / %d", i + 1, len(test_data))

    return predictions, references


def main():
    args = parse_args()

    # Auto-detect CTranslate2 format
    if os.path.exists(os.path.join(args.model_dir, "model.bin")):
        args.model_format = "ctranslate2"
        logger.info("Detected CTranslate2 model format.")

    logger.info("Evaluating: %s (format=%s, split=%s)", args.model_dir, args.model_format, args.split)

    test_data = load_test_data(args.language, args.split, args.hf_token, args.max_samples)
    logger.info("Test samples: %d", len(test_data))

    if args.model_format == "hf":
        predictions, references = evaluate_hf(args, test_data)
    else:
        predictions, references = evaluate_ct2(args, test_data)

    wer_metric = hf_evaluate.load("wer")
    wer = wer_metric.compute(predictions=predictions, references=references) * 100

    logger.info("=" * 50)
    logger.info("RESULTS")
    logger.info("  Model:    %s", args.model_dir)
    logger.info("  Split:    %s (%d samples)", args.split, len(references))
    logger.info("  WER:      %.2f%%", wer)
    logger.info("=" * 50)


if __name__ == "__main__":
    main()
