#!/usr/bin/env python3
"""Convert a fine-tuned Whisper model (HF format) to CTranslate2 format for faster-whisper."""

import argparse
import logging
import os

import ctranslate2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def parse_args():
    p = argparse.ArgumentParser(description="Convert Whisper HF model to CTranslate2")
    p.add_argument("--model_dir", required=True, help="Path to fine-tuned HF model directory")
    p.add_argument("--output_dir", required=True, help="Path to write CTranslate2 model")
    p.add_argument(
        "--quantization",
        default=os.environ.get("QUANTIZATION", "int8"),
        choices=["float16", "float32", "int8", "int8_float16", "int8_bfloat16"],
        help="Quantization type (default: int8 for CPU)",
    )
    return p.parse_args()


def main():
    args = parse_args()

    logger.info("Converting: %s -> %s (quantization=%s)", args.model_dir, args.output_dir, args.quantization)

    converter = ctranslate2.converters.TransformersConverter(
        model_name_or_path=args.model_dir,
        copy_files=[
            "tokenizer.json",
            "preprocessor_config.json",
            "special_tokens_map.json",
            "added_tokens.json",
            "normalizer.json",
            "vocab.json",
            "merges.txt",
        ],
    )

    converter.convert(
        output_dir=args.output_dir,
        quantization=args.quantization,
        force=True,
    )

    logger.info("Conversion complete. Output: %s", os.listdir(args.output_dir))
    logger.info(
        "\nTo deploy, set in .env:\n"
        "  HOST_MODEL_PATH=%s\n"
        "  WHISPER_COMPUTE_TYPE=%s\n"
        "Then: docker compose restart worker",
        os.path.abspath(args.output_dir),
        args.quantization,
    )


if __name__ == "__main__":
    main()
