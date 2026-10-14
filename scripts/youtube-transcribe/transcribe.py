#!/usr/bin/env python3
"""Gladia で YouTube 動画を文字起こしする（重複送信防止つき）。

usage:
  transcribe.py submit <meta.json> <ledger.json>   # 未送信の動画だけを 1 回ずつ送信
  transcribe.py fetch  <ledger.json> <out.json>    # 完了したジョブの文字起こしを取得

重複防止:
  1. 送信前に ledger（video_id -> job_id）を確認し、記録済みならスキップ
  2. 送信直前に Gladia の最新ジョブ一覧を取得し、同じ URL のジョブがあればスキップ
  3. POST は再試行しない。応答が不明なら即停止し、一覧で状態を確認してから再実行する
  4. 1 件送信するごとに ledger を書き出す
"""
import json
import os
import subprocess
import sys
import time

API = "https://api.gladia.io/v2/pre-recorded"


def curl(*args):
    out = subprocess.run(["curl", "-sS", "--max-time", "120", *args],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"curl failed: {out.stderr.strip()}")
    return out.stdout


def load(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def recent_job_sources(pages=3):
    """最新ジョブ（新しい順）の audio_url / custom_metadata.video_id -> job_id。

    queued 中のジョブは audio_url が null で返るため、video_id でも照合する。
    """
    found, url = {}, f"{API}?limit=100"
    for _ in range(pages):
        d = json.loads(curl(url))
        for j in d["items"]:
            src = (j.get("request_params") or {}).get("audio_url")
            if src:
                found.setdefault(src, j["id"])
            meta_vid = (j.get("custom_metadata") or {}).get("video_id")
            if meta_vid:
                found.setdefault(video_url(meta_vid), j["id"])
        url = d.get("next")
        if not url:
            break
    return found


def video_url(vid):
    return f"https://www.youtube.com/watch?v={vid}"


def submit(meta_path, ledger_path):
    videos = load(meta_path, [])
    ledger = load(ledger_path, {})
    for v in videos:
        vid = v["id"]
        if vid in ledger:
            print(f"skip (ledger) {vid} -> {ledger[vid]}")
            continue
        url = video_url(vid)
        existing = recent_job_sources().get(url)
        if existing:
            ledger[vid] = existing
            save(ledger_path, ledger)
            print(f"skip (already on Gladia) {vid} -> {existing}")
            continue
        body = {
            "audio_url": url,
            "language_config": {"languages": ["ja"], "code_switching": False},
            "custom_metadata": {"video_id": vid, "source": "tonyobyo_amakana"},
        }
        try:
            raw = curl("-X", "POST", API, "-H", "Content-Type: application/json",
                       "-d", json.dumps(body))
        except RuntimeError as e:
            raw = str(e)
        try:
            job_id = json.loads(raw)["id"]
        except (ValueError, KeyError):
            # 応答不明でも Gladia 側で受理されていることがある。再送はせず一覧で探す
            time.sleep(10)
            job_id = recent_job_sources(pages=1).get(url)
            if not job_id:
                sys.exit(f"unexpected response for {vid}, not found on Gladia, "
                         f"stopping without resend: {raw[:500]}")
            print(f"ambiguous response, found accepted job for {vid}")
        ledger[vid] = job_id
        save(ledger_path, ledger)
        print(f"submitted {vid} -> {job_id}")
        time.sleep(1)


def fetch(ledger_path, out_path):
    ledger = load(ledger_path, {})
    results = load(out_path, {})
    pending = 0
    for vid, job_id in ledger.items():
        if vid in results:
            continue
        d = json.loads(curl(f"{API}/{job_id}"))
        status = d.get("status")
        if status == "done":
            results[vid] = d["result"]["transcription"]["full_transcript"]
            print(f"done {vid}")
        elif status == "error":
            results[vid] = f"[ERROR] {d.get('error_code')}"
            print(f"error {vid}: {d.get('error_code')}")
        else:
            pending += 1
    save(out_path, results)
    print(f"pending: {pending}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "submit":
        submit(sys.argv[2], sys.argv[3])
    elif cmd == "fetch":
        fetch(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
