"""Instagram リール一括ダウンロード＆文字起こしアプリ（ローカル実行用）"""

import csv
import io
import json
from pathlib import Path

import instaloader
import streamlit as st
from instaloader.exceptions import (
    BadCredentialsException,
    ConnectionException,
    InstaloaderException,
    LoginRequiredException,
    ProfileNotExistsException,
    TwoFactorAuthRequiredException,
)

OUTPUT_DIR = Path(__file__).parent / "output"

st.set_page_config(page_title="リール文字起こし", page_icon="🎬")
st.title("🎬 リール一括文字起こし")
st.caption("自分のアカウントや、許可を得たアカウントの動画に使ってください。")

ss = st.session_state
ss.setdefault("loader", None)
ss.setdefault("need_2fa", False)


def new_loader() -> instaloader.Instaloader:
    return instaloader.Instaloader(
        dirname_pattern=str(OUTPUT_DIR / "{target}"),
        filename_pattern="{shortcode}",
        download_pictures=False,
        download_video_thumbnails=False,
        save_metadata=False,
        compress_json=False,
        post_metadata_txt_pattern="",
        quiet=True,
    )


@st.cache_resource(show_spinner="文字起こしモデルを準備中（初回のみ数分かかります）...")
def load_model(name: str):
    from faster_whisper import WhisperModel

    return WhisperModel(name, device="auto", compute_type="int8")


# ---------------- ステップ1: ログイン ----------------
st.header("① ログイン")

if ss.loader is not None:
    st.success(f"ログイン中：{ss.loader.context.username}")
    if st.button("ログアウト"):
        ss.loader = None
        st.rerun()
elif ss.need_2fa:
    st.info("二段階認証のコードが届いています。入力してください。")
    code = st.text_input("認証コード（6桁）")
    if st.button("認証する", type="primary"):
        try:
            ss.pending_loader.two_factor_login(code.strip())
            ss.pending_loader.save_session_to_file()
            ss.loader, ss.need_2fa = ss.pending_loader, False
            st.rerun()
        except InstaloaderException as e:
            st.error(f"認証に失敗しました：{e}")
else:
    st.write("Instagram のアカウントでログインします（捨てアカウント推奨）。")
    username = st.text_input("ユーザー名（@なし）").strip().lstrip("@")
    password = st.text_input(
        "パスワード（2回目以降は空欄でOK）", type="password"
    )
    if st.button("ログイン", type="primary", disabled=not username):
        L = new_loader()
        try:
            L.load_session_from_file(username)
            if L.test_login() != username:
                raise FileNotFoundError
            ss.loader = L
            st.rerun()
        except (FileNotFoundError, InstaloaderException):
            L = new_loader()
            if not password:
                st.warning("保存されたログイン情報がありません。パスワードを入力してください。")
            else:
                try:
                    with st.spinner("ログイン中..."):
                        L.login(username, password)
                    L.save_session_to_file()
                    ss.loader = L
                    st.rerun()
                except TwoFactorAuthRequiredException:
                    ss.pending_loader, ss.need_2fa = L, True
                    st.rerun()
                except BadCredentialsException:
                    st.error("ユーザー名かパスワードが違います。")
                except InstaloaderException as e:
                    st.error(
                        "ログインできませんでした。一度 Instagram のアプリかブラウザで"
                        "このアカウントにログインし、確認画面が出ていれば済ませてから再度お試しください。"
                        f"\n\n詳細：{e}"
                    )

# ---------------- ステップ2: 実行 ----------------
st.header("② リールを取得して文字起こし")

target = st.text_input("対象アカウント名（@なし）").strip().lstrip("@")
col1, col2 = st.columns(2)
limit = col1.number_input(
    "今回取得する件数（0 = すべて）",
    min_value=0,
    value=20,
    step=10,
    help="新しいものから順に取得します。取得済みのリールは自動でスキップされ、件数に数えません。",
)
model_name = col2.selectbox(
    "文字起こしの精度",
    ["small", "medium", "large-v3"],
    index=1,
    format_func=lambda m: {"small": "速い（small）", "medium": "標準（medium）", "large-v3": "高精度・遅い（large-v3）"}[m],
)
st.caption("同じアカウントで何度実行しても重複しません。新しく投稿されたリールと、まだ取っていない古いリールだけを取得します。")

start = st.button(
    "開始", type="primary", disabled=ss.loader is None or not target
)
if ss.loader is None:
    st.caption("先に ① でログインしてください。")


def is_done(folder: Path, code: str) -> bool:
    txt = folder / f"{code}.txt"
    return (folder / f"{code}.json").exists() and txt.exists()


def load_all_rows(folder: Path) -> list[dict]:
    """これまでに取得したすべてのリールを、新しい順に並べて返す。"""
    rows = []
    for meta_file in folder.glob("*.json"):
        txt = meta_file.with_suffix(".txt")
        if not txt.exists():
            continue
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        rows.append({**meta, "文字起こし": txt.read_text(encoding="utf-8")})
    return sorted(rows, key=lambda r: r["投稿日"], reverse=True)


def iter_reel_codes(profile):
    """リール一覧からショートコードだけを取り出す。

    get_reels() はリールごとに詳細を取りに行くため、取得済みのものまで
    アクセスが増えてしまう。一覧だけを読み、詳細は新しいものだけ取りに行く。
    """
    it = profile.get_reels()
    if hasattr(it, "_node_wrapper"):
        it._node_wrapper = lambda n: n["media"]["code"]
        it._is_first = None
        yield from it
    else:  # Instaloader の内部が変わった場合の保険
        for post in it:
            yield post.shortcode


if start:
    L = ss.loader
    folder = OUTPUT_DIR / target
    folder.mkdir(parents=True, exist_ok=True)
    model = load_model(model_name)

    status = st.empty()
    progress = st.progress(0.0)
    new_count = skipped = 0

    try:
        status.write("アカウント情報を取得中...")
        profile = instaloader.Profile.from_username(L.context, target)
        for code in iter_reel_codes(profile):
            if is_done(folder, code):
                skipped += 1
                status.write(f"取得済みをスキップ中...（{skipped} 本）")
                continue
            if limit and new_count >= limit:
                break

            n = new_count + 1
            status.write(f"新規 {n} 本目：ダウンロード中（{code}）")
            post = instaloader.Post.from_shortcode(L.context, code)
            if not list(folder.glob(f"{code}*.mp4")):
                L.download_post(post, target=target)
            videos = sorted(folder.glob(f"{code}*.mp4"))
            if not videos:
                continue

            status.write(f"新規 {n} 本目：文字起こし中（{code}）")
            segments, _ = model.transcribe(
                str(videos[0]), language="ja", vad_filter=True
            )
            text = "".join(s.text for s in segments).strip()
            (folder / f"{code}.txt").write_text(text, encoding="utf-8")
            meta = {
                "投稿日": post.date_local.strftime("%Y-%m-%d %H:%M"),
                "URL": f"https://www.instagram.com/reel/{code}/",
                "キャプション": (post.caption or "").strip(),
            }
            (folder / f"{code}.json").write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8"
            )

            new_count += 1
            if limit:
                progress.progress(min(new_count / limit, 1.0))
        progress.progress(1.0)
        status.success(
            f"完了しました。新しく {new_count} 本を文字起こししました"
            f"（取得済みでスキップ：{skipped} 本）。保存先：{folder}"
        )
    except ProfileNotExistsException:
        status.error("対象アカウントが見つかりません。名前を確認してください。")
    except LoginRequiredException:
        status.error("ログインが切れました。① でもう一度ログインしてください。")
        ss.loader = None
    except ConnectionException as e:
        status.error(
            "Instagram から一時的に制限されました。数時間あけてから再度お試しください。"
            "（取得済みの分は保存されているので、次回は続きから進みます）"
            f"\n\n詳細：{e}"
        )
    except InstaloaderException as e:
        status.error(f"エラーが発生しました：{e}")

    rows = load_all_rows(folder)
    if rows:
        st.write(f"これまでに取得した合計：{len(rows)} 本")
        st.dataframe(rows, use_container_width=True)

        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        csv_bytes = buf.getvalue().encode("utf-8-sig")  # Excel で文字化けしないように
        (folder / "_一覧.csv").write_bytes(csv_bytes)
        all_text = "\n\n".join(
            f"===== {r['投稿日']} {r['URL']} =====\n{r['文字起こし']}" for r in rows
        )
        (folder / "_全文.txt").write_text(all_text, encoding="utf-8")

        c1, c2 = st.columns(2)
        c1.download_button("📊 一覧をCSVで保存", csv_bytes, f"{target}_一覧.csv", "text/csv")
        c2.download_button("📝 全文をテキストで保存", all_text.encode("utf-8"), f"{target}_全文.txt", "text/plain")
