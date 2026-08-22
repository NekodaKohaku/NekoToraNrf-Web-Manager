# NekoTora ファームウェア / Firmware Updater / 韌體更新

**➡️ 更新ページ / Updater / 更新網頁:<https://nekodakohaku.github.io/NekoToraNrf-Web-Manager/>**

パソコン版 Chrome または Edge が必要です。/ Requires desktop Chrome or Edge. / 需使用電腦版 Chrome 或 Edge。

更新方法は3つあります。書き込まれるファームウェアは同じで、経路が違うだけです。
There are three update methods. They install the same firmware; only the route differs.
共有三種更新方式,寫入的韌體相同,差別只在傳輸途徑。

---

## 🇯🇵 日本語:更新のしかた

ページを Chrome / Edge で開き、**① 更新方法を選ぶ** → **② 接続** → **③ ファームウェア** → **④ 更新** の順に進みます。
ファームウェアは自動的に最新版が選ばれます。ファイルを自分で選ぶ必要はありません。

### ワイヤレス更新(推奨)

1. NekoTora Dongle をパソコンに挿し、「**Dongle を接続**」をクリックして一覧から選びます。
2. トラッカーが自動的に検索され、それぞれの現在のバージョンが表示されます。更新できるものは最初から選択済みです。
3. 「**更新を開始**」をクリックします。トラッカーに触れる必要はありません。
4. 完了するとトラッカーは自動的に再起動します。

「準備中」の表示が数秒続くのは正常です。トラッカーが更新用の領域を消去しています。

### 有線更新

1. USB-TTL 変換基板をトラッカーに接続します(TX→RX、RX→TX、GND 共通)。
2. 「**シリアルポートを接続**」→「**更新モードに入る**」の順にクリックします。
3. 反応がない場合は、トラッカーのボタンを素早く4回押すか、RESET を1回押してください。
4. 「**更新を開始**」をクリックします。

### SWD 書き込み(上級者向け・復旧用)

1. CMSIS-DAP 書き込み器を接続し、「**接続**」をクリックします。
2. **トラッカーのボタンを押したまま**、「**更新を開始**」をクリックします。更新中はボタンを押し続け、USB を抜かないでください。
3. 「**更新が完了しました**」と表示されたら、ボタンを離してください。
4. 失敗した場合:ボタンを離し、USB を抜き差ししてから、再度ボタンを押したまま「もう一度試す」をクリックしてください。

---

## 🇬🇧 English: How to update

Open the page in Chrome / Edge and work down: **① choose a method** → **② connect** → **③ firmware** → **④ update**.
The latest firmware is selected for you; you do not need to pick a file.

### Wireless (recommended)

1. Plug in the NekoTora Dongle, click "**Connect Dongle**" and select it in the popup.
2. Trackers are found automatically and their current versions shown. Anything that can be updated is pre-selected.
3. Click "**Start update**". You do not need to touch the trackers.
4. Each tracker restarts itself when it finishes.

A few seconds of "Preparing" is normal — the tracker is erasing its update area.

### Wired

1. Wire a USB-TTL adapter to the tracker (TX→RX, RX→TX, common GND).
2. Click "**Connect serial port**", then "**Enter update mode**".
3. If nothing happens, press the tracker button four times quickly, or tap RESET.
4. Click "**Start update**".

### SWD (advanced / recovery)

1. Connect a CMSIS-DAP programmer and click "**Connect**".
2. **Press and hold the button on the tracker**, then click "**Start update**". Keep holding it and do not unplug USB.
3. When the screen shows "**Update complete**", release the button.
4. If it fails: release the button, unplug and replug USB, hold the button again and click "Try again".

---

## 🇹🇼 中文:如何更新

用 Chrome / Edge 開啟網頁,依序完成 **① 選擇更新方式** → **② 連接** → **③ 韌體** → **④ 更新**。
韌體會自動選用最新版,不需要自己挑檔案。

### 無線更新(推薦)

1. 把 NekoTora Dongle 插上電腦,點「**連接 Dongle**」並在跳出的視窗中選擇它。
2. 網頁會自動搜尋追蹤器並顯示各自的版本,可更新的會預先勾選。
3. 點「**開始更新**」。全程不需要碰追蹤器。
4. 完成後追蹤器會自動重新啟動。

畫面停在「準備中」數秒是正常的,追蹤器正在抹除更新用的區塊。

### 有線更新

1. 把 USB-TTL 轉接板接到追蹤器(TX→RX、RX→TX、GND 共地)。
2. 依序點「**連接序列埠**」→「**進入更新模式**」。
3. 若沒有反應,快速連按追蹤器按鈕 4 下,或按一下 RESET。
4. 點「**開始更新**」。

### SWD 燒錄(進階 / 修復)

1. 接上 CMSIS-DAP 燒錄器,點「**連接裝置**」。
2. **按住追蹤器上的按鈕不放**,點「**開始更新**」。過程中請一直按住、不要拔 USB。
3. 畫面顯示「**更新完成**」後放開按鈕。
4. 若顯示失敗:放開按鈕,拔掉 USB 重新插上,再按住按鈕點「再試一次」。

---

## 開發 / Development

静的サイトです。ビルド不要。/ Static site, no build step. / 純靜態網站,不需要建置。

```
index.html            markup and styles only
js/app.js             UI and flow control
js/i18n.js            zh / en / ja strings
js/config.js          chip constants, built-in device defaults
js/registry.js        devices.json + firmware manifest
js/util.js            logging, CRC32, formatting
js/hex.js             Intel HEX parsing
js/image.js           .update.bin (MCUboot image) handling
js/swd.js             CMSIS-DAP transports, SWD, NVMC
js/flash.js           SWD update flow
js/ota.js             wireless: ESB OTA over WebHID (via the dongle)
js/smp.js             wired: MCUboot serial recovery over Web Serial
test/                 node tests - `node test/run.mjs`
```

ES modules are loaded natively, so the files can be split without a bundler and
GitHub Pages serves them as-is.

### ファームウェアの公開 / Publishing firmware / 發佈韌體

通常はトラッカー側の Build workflow が自動で行います。
Normally the tracker's Build workflow does this for you.
一般情況由追蹤器的 Build workflow 自動完成。

```
1. トラッカーのリポジトリで  git tag 1.0.0 && git push origin 1.0.0
   ('v' は付けない。v1.0.0 は CMake の --match に一致せず版が 0.0.0 になる)
2. Actions -> Build Firmware -> flash=mcuboot, publish=true
3. このリポジトリへ自動で commit され、Pages に反映される
```

**版数は git tag からしか来ません。** `CMakeLists.txt` の
`git describe --match [0-9]*.[0-9]*.[0-9]*` が唯一の出どころで、一致する tag が
無いと固件は 0.0.0 を名乗ります。更新ページは固件が報告する版と `versionCode`
を比較して更新可否を決めるため、0.0.0 のままでは自動更新が成立しません。
そのため tag は必ずビルドより先に push してください。

手動で置く場合 / To do it by hand / 手動放置時:

Update `firmware/<device>/latest.json` and drop the files beside it.

```json
{
  "version": "1.4.2",
  "versionCode": 66562,
  "boardTarget": "promicro_uf2/nrf52840/spi",
  "hex": "nekotora-1.4.2.hex",
  "bin": "nekotora-1.4.2.update.bin",
  "date": "2026-08-20"
}
```

- `versionCode` は `0x00MMmmpp`(1.4.2 → `0x010402` → 66562)。
- `bin` は MCUboot 更新イメージ(`.update.bin`)。ワイヤレスと有線が使います。
- `hex` は MCUboot を含む完全イメージ = ビルド成果物の **`.first_flash.hex`**。
  SWD だけが使います。ビルドツリーの `zephyr.hex` を置くと bootloader が消え、
  以後 SWD でしか復旧できなくなります。
- `boardTarget` はファームウェアの `CONFIG_BOARD_TARGET` と完全に一致させること。
  トラッカー側が照合し、一致しなければ書き込みを拒否します。

初回セットアップ / One-time setup / 首次設定:
トラッカー側リポジトリの Secrets に `WEB_MANAGER_TOKEN` を追加します
(このリポジトリへの `contents: write` を持つ fine-grained PAT)。
トラッカー側は private、こちらは public なので、既定の `GITHUB_TOKEN` では
届きません。

### テスト / Tests

```
npm i jsdom      # only needed for the UI test
node test/run.mjs
```

- `test/ota.test.mjs` — ESB OTA against a simulated dongle: parallel targets,
  packet loss and replay, slow slot erase, board mismatch, CRC failure.
- `test/smp.test.mjs` — SMP framing round-trip, CRC-16 vector, upload to completion.
- `test/ui.test.mjs` — loads the real page in jsdom: method switching, gating,
  and that every string resolves in all three languages.
