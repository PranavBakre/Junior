# MP4 to SRT on Apple Silicon

This note covers local transcription of 10 minute to 4 hour MP4 files on Apple Silicon Macs, with Hinglish as a likely input language. The goal is to extract subtitles as `.srt` files while keeping memory use predictable and allowing safe parallel batch processing.

## Recommendation

Use `mlx-whisper` first for command-line workflows.

- It is optimized for Apple Silicon through Apple MLX.
- It can read video/audio inputs and write SRT output directly.
- `whisper-large-v3-turbo` is the best default tradeoff for long Hinglish files.
- It is easier to batch and parallelize than GUI tools.

Use MacWhisper if you want a polished GUI editor for long subtitle files. It supports local transcription, SRT export, and larger Whisper models in the paid version.

Use `whisper.cpp` if you want the most mature low-level native implementation. It is efficient and Apple Silicon friendly, but the workflow is more manual.

Use `mlx-qwen3-asr` as a test candidate if Hindi/Hinglish accuracy is weak with Whisper. It supports Hindi and English, emits SRT, and runs natively through MLX, but it is newer than Whisper-based tooling.

## Install

Install ffmpeg:

```bash
brew install ffmpeg
```

Install `mlx-whisper`:

```bash
pip install mlx-whisper
```

Optional candidate for Hindi/Hinglish comparison:

```bash
pip install mlx-qwen3-asr
```

## Single File Workflow

Direct MP4 to SRT:

```bash
mlx_whisper input.mp4 \
  --model mlx-community/whisper-large-v3-turbo \
  -f srt \
  -o ./subs
```

More robust long-file workflow:

```bash
mkdir -p audio subs

ffmpeg -i input.mp4 \
  -vn \
  -ac 1 \
  -ar 16000 \
  -c:a pcm_s16le \
  audio/input.wav

mlx_whisper audio/input.wav \
  --model mlx-community/whisper-large-v3-turbo \
  -f srt \
  -o ./subs
```

The extracted WAV is larger than compressed audio, but it reduces surprises from unusual MP4 audio codecs and makes retries cheaper.

## Hinglish Notes

Use multilingual models, not `.en` models.

For Hinglish, test a 10 minute sample before running a full batch. Accuracy can vary by speaker, background noise, code-switching, and whether Hindi words should appear in Devanagari or Roman script.

Recommended test order:

```bash
mlx_whisper sample.mp4 \
  --model mlx-community/whisper-large-v3-turbo \
  -f srt \
  -o ./test-whisper
```

```bash
mlx-qwen3-asr sample.mp4 \
  --language Hindi \
  -f srt \
  -o ./test-qwen
```

If the target output is Romanized Hinglish, expect a post-processing step after transcription. Most ASR models may output Hindi portions in Devanagari when the language is detected as Hindi.

## Memory Use

These are practical planning estimates for unified memory, not hard limits. Actual usage depends on audio length, model cache, Python overhead, and whether multiple jobs run at once.

| Tool/model | Practical RAM per job | Notes |
| --- | ---: | --- |
| `mlx-whisper tiny/base/small` | 1-3 GB | Fast, lower accuracy |
| `mlx-whisper medium` | 4-6 GB | Better quality |
| `mlx-whisper large-v3-turbo` | 5-8 GB | Recommended default |
| `mlx-whisper large-v3` | 8-12+ GB | Heavier, slower |
| `whisper.cpp large-v3-turbo` | 4-8 GB | Efficient, more setup |
| `mlx-qwen3-asr 0.6B` | 3-6 GB | Worth testing for Hindi/Hinglish |
| `mlx-qwen3-asr 1.7B` | 6-10+ GB | Higher accuracy candidate |

Parallelism guidance:

| Mac memory | Suggested `large-v3-turbo` jobs |
| ---: | ---: |
| 8 GB | 1 |
| 16 GB | 1-2 |
| 24 GB | 2-3 |
| 32 GB | 3-4 |
| 64 GB+ | 4-8 |

Start conservatively and watch Activity Monitor memory pressure. If memory pressure turns yellow or red, reduce parallelism.

## Parallel Batch Workflow

Parallelize across files, not within a single file.

Simple batch command:

```bash
mkdir -p subs

find videos -name '*.mp4' -print0 | xargs -0 -P 2 -I{} \
  mlx_whisper "{}" \
    --model mlx-community/whisper-large-v3-turbo \
    -f srt \
    -o ./subs
```

Change `-P 2` based on available RAM.

For a more robust workflow that extracts audio first:

```bash
mkdir -p audio subs

find videos -name '*.mp4' -print0 | xargs -0 -P 2 -I{} sh -c '
  in="$1"
  base="$(basename "$in" .mp4)"
  wav="audio/$base.wav"

  ffmpeg -y -i "$in" \
    -vn \
    -ac 1 \
    -ar 16000 \
    -c:a pcm_s16le \
    "$wav"

  mlx_whisper "$wav" \
    --model mlx-community/whisper-large-v3-turbo \
    -f srt \
    -o ./subs
' sh {}
```

This is safer for long files and unusual MP4 audio tracks, but uses more disk space while the WAV files exist.

## Operational Tips

- Keep filenames simple where possible. Spaces are supported by the commands above, but clean names make review easier.
- Keep `-P` low for 4 hour files, especially on 16 GB machines.
- Run one 10 minute representative file before committing to a full folder.
- Keep original MP4 files unchanged; write audio and subtitles to separate `audio/` and `subs/` directories.
- Review SRT timing on a long sample before publishing.

## References

- MacWhisper: https://www.macwhisper.net/
- `mlx-whisper`: https://github.com/ml-explore/mlx-examples/tree/main/whisper
- `whisper.cpp`: https://github.com/ggml-org/whisper.cpp
- `mlx-qwen3-asr`: https://github.com/moona3k/mlx-qwen3-asr/
