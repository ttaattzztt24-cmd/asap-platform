"""Instagram リール一括ダウンロード＆文字起こしアプリ（ローカル実行用）"""

import csv
import io
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
limit = col1.number_input("最大件数（0 = すべて）", min_value=0, value=20, step=10)
model_name = col2.selectbox(
    "文字起こしの精度",
    ["small", "medium", "large-v3"],
    index=1,
    format_func=lambda m: {"small": "速い（small）", "medium": "標準（medium）", "large-v3": "高精度・遅い（large-v3）"}[m],
)

start = st.button(
    "開始", type="primary", disabled=ss.loader is None or not target
)
if ss.loader is None:
    st.caption("先に ① でログインしてください。")

if start:
    L = ss.loader
    folder = OUTPUT_DIR / target
    folder.mkdir(parents=True, exist_ok=True)
    model = load_model(model_name)

    status = st.empty()
    progress = st.progress(0.0)
    table = st.empty()
    rows = []

    try:
        status.write("アカウント情報を取得中...")
        profile = instaloader.Profile.from_username(L.context, target)
        for i, post in enumerate(profile.get_reels(), start=1):
            if limit and i > limit:
                break
            code = post.shortcode
            status.write(f"{i} 本目：ダウンロード中（{code}）")
            if not list(folder.glob(f"{code}*.mp4")):
                L.download_post(post, target=target)
            videos = sorted(folder.glob(f"{code}*.mp4"))
            if not videos:
                continue

            txt = folder / f"{code}.txt"
            if txt.exists() and txt.read_text(encoding="utf-8").strip():
                text = txt.read_text(encoding="utf-8")
            else:
                status.write(f"{i} 本目：文字起こし中（{code}）")
                segments, _ = model.transcribe(
                    str(videos[0]), language="ja", vad_filter=True
                )
                text = "".join(s.text for s in segments).strip()
                txt.write_text(text, encoding="utf-8")

            rows.append(
                {
                    "投稿日": post.date_local.strftime("%Y-%m-%d %H:%M"),
                    "URL": f"https://www.instagram.com/reel/{code}/",
                    "キャプション": (post.caption or "").strip(),
                    "文字起こし": text,
                }
            )
            table.dataframe(rows, use_container_width=True)
            if limit:
                progress.progress(min(i / limit, 1.0))
        progress.progress(1.0)
        status.success(f"完了しました（{len(rows)} 本）。保存先：{folder}")
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

    if rows:
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
