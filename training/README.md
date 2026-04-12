# Fine-Tuning Whisper for Afrikaans

Fine-tune OpenAI's Whisper model on Afrikaans audio data and deploy it to the transcription service.

## Prerequisites

- Docker and Docker Compose v2
- A [Hugging Face](https://huggingface.co) account + access token
- Accept the [Common Voice dataset terms](https://huggingface.co/datasets/mozilla-foundation/common_voice_17_0)
- 16 GB RAM minimum (32 GB recommended)
- ~20 GB free disk space

## Model Size Guide

| Model | Parameters | RAM (CPU) | Training Time* |
|-------|-----------|-----------|----------------|
| `openai/whisper-small` | 244M | ~8 GB | ~4 hours |
| `openai/whisper-medium` | 769M | ~16 GB | ~12 hours |
| `openai/whisper-large-v3` | 1.5B | ~32 GB | Days (not recommended on CPU) |

*Approximate for 3 epochs on ~3000 Common Voice samples.

**Recommendation**: Start with `whisper-small`. A fine-tuned small model on Afrikaans data often outperforms a generic large model.

## Quick Start

### 1. Configure

```bash
# Set your Hugging Face token
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. Train

```bash
docker compose -f docker-compose.train.yml run --rm train
```

### 3. Convert to faster-whisper format

```bash
docker compose -f docker-compose.train.yml run --rm convert
```

The converted model is written to `./models/whisper/` by default.

### 4. Evaluate

```bash
docker compose -f docker-compose.train.yml run --rm evaluate
```

### 5. Deploy

```bash
# Update .env to point to your fine-tuned model
HOST_MODEL_PATH=./models/whisper

# Restart the worker
docker compose restart worker
```

## Adding Your Own Training Data

Corrected transcripts from the editor can be exported as training data (click "Eksporteer" in the editor toolbar). You can also add your own audio recordings.

Place files in `training/custom_data/` using either format:

### Option A: CSV manifest

```
training/custom_data/
  audio/
    recording_001.wav
    recording_002.mp3
  transcripts.csv
```

`transcripts.csv` format:
```csv
file_name,sentence
recording_001.wav,Die kat sit op die mat.
recording_002.mp3,"Goeie more, hoe gaan dit?"
```

### Option B: Paired files

```
training/custom_data/
  recording_001.wav
  recording_001.txt    # Contains: Die kat sit op die mat.
  recording_002.mp3
  recording_002.txt    # Contains: Goeie more, hoe gaan dit?
```

Audio files can be in any format supported by ffmpeg. They are automatically resampled to 16kHz.

Custom data is combined with Common Voice during training.

## Customizing Hyperparameters

Override via environment variables:

```bash
WHISPER_MODEL=openai/whisper-medium \
NUM_TRAIN_EPOCHS=5 \
LEARNING_RATE=5e-6 \
PER_DEVICE_TRAIN_BATCH_SIZE=2 \
docker compose -f docker-compose.train.yml run --rm train
```

## Training Without Docker

```bash
cd training
pip install -r requirements.txt

python train.py \
  --model_name openai/whisper-small \
  --output_dir ./output \
  --hf_token $HF_TOKEN

python convert.py \
  --model_dir ./output \
  --output_dir ../models/whisper \
  --quantization int8

python evaluate.py \
  --model_dir ./output
```

## Training Loop (Corrections -> Retraining)

1. Transcribe audio using the service
2. Correct the transcript in the editor
3. Export training data (click "Eksporteer")
4. Place exported audio segments in `training/custom_data/`
5. Re-train the model
6. Convert and deploy

Each iteration improves the model on your specific domain and vocabulary.
