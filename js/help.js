/* Help page: status lights, buttons, common questions.
 *
 * Kept as data per language rather than as i18n keys: it is a document, not
 * UI chrome, and reading it top to bottom in one place is what keeps the three
 * languages saying the same thing. Sources: tracker docs/led.md and
 * src/system/system.c (buttons), receiver src/system/system.c (dongle
 * buttons) and src/main.c (hold at power-up). Defaults of the standard build;
 * a custom build can differ.
 */

/* Light patterns as [brightness 0..1, ms] segments, repeated. Colours are the
 * RGB / LED-strip build's (NekoTora ships LED-strip trackers only).
 * NekoTora trackers have no charger, so the firmware's charging / charged
 * patterns are left out. */
const Q = [[1, 200], [0, 200]];                       // one "quick" blink
const quick = (n, pauseMs = 0) => [...Array(n).fill(Q).flat(), ...(pauseMs ? [[0, pauseMs]] : [])];
/* Error codes: 0.5 s on / 0.5 s off, n times, repeated every 5 s. */
const slow = n => [...Array(n).fill([[1, 500], [0, 500]]).flat(), [0, 5000 - n * 1000]];
/* Power-off: a moment dark, then a one-second fade, shown on a loop. */
const fade = [[0, 250], ...Array.from({ length: 10 }, (_, i) => [1 - i / 10, 100]), [0, 1500]];

const C = {
  def: 'rgb(102,153,0)', ok: 'rgb(0,200,60)', err: 'rgb(230,30,30)', chg: 'rgb(230,90,0)',
  pair: 'rgb(30,90,255)', doze: 'rgb(140,40,255)', ping: 'rgb(255,255,255)', cal: 'rgb(0,200,255)',
};

const LED = [
  { k: 'normal',   c: C.def,  seq: [[1, 300], [0, 9700]] },
  { k: 'boot',     c: C.def,  seq: quick(3, 2000) },
  { k: 'shutdown', c: C.def,  seq: fade },
  { k: 'dozeIn',   c: C.doze, seq: quick(2, 2400) },
  { k: 'dozing',   c: null,   seq: [[0, 1000]] },
  { k: 'pairing',  c: C.pair, seq: [[1, 100], [0, 900]] },
  { k: 'paired',   c: C.ok,   seq: quick(4, 1600) },
  { k: 'ping',     c: C.ping, seq: quick(10, 1000) },
  { k: 'btnHeld',  c: C.def,  seq: [[1, 1000]] },
  { k: 'btnAck',   c: C.ok,   seq: quick(2, 2400) },
  { k: 'holdOff',  c: C.def,  seq: [[1, 500], [0, 500]] },
  { k: 'calStill', c: C.cal,  seq: [[1, 500], [0, 500]] },
  { k: 'calRec',   c: C.cal,  seq: [[1, 1000]] },
  { k: 'calDone',  c: C.ok,   seq: quick(4, 1600) },
  { k: 'tcalRun',  c: C.cal,  seq: [[1, 300], [0, 9700]] },
  { k: 'tcalSlot', c: C.cal,  seq: [[1, 100], [0, 100], [1, 100], [0, 2700]] },
  { k: 'ota',      c: C.chg,  seq: [[1, 100], [0, 100]] },
  { k: 'otaWait',  c: C.chg,  breathe: 3000 },
  { k: 'dfu',      c: C.ping, seq: [[0.6, 1000]] },
  { k: 'lowBatt',  c: C.chg,  seq: [[0.2, 500], [0, 500]] },
  { k: 'errSensor',   c: C.err, seq: slow(2) },
  { k: 'errReceiver', c: C.err, seq: slow(3) },
  { k: 'errSystem',   c: C.err, seq: slow(4) },
];

/* Dongle: one single-colour LED (receiver src/main.c, system/system.c,
 * connection/esb.c). Shown in a neutral colour. */
const D = 'rgb(255,190,60)';
const LED_DONGLE = [
  { k: 'dNormal',  c: D, seq: [[1, 300], [0, 9700]] },
  { k: 'dPairing', c: D, seq: [[1, 100], [0, 900]] },
  { k: 'dPaired',  c: D, seq: quick(2, 2400) },
  { k: 'dDozeAll', c: D, seq: quick(2, 2400) },
  { k: 'dWakeAll', c: D, seq: quick(3, 2000) },
  { k: 'dNothing', c: D, seq: slow(2) },
  { k: 'dHeld',    c: D, seq: [[1, 1000], [0, 1000]] },
  { k: 'dCleared', c: D, seq: quick(4, 1600) },
  { k: 'dRescue',  c: D, seq: [[1, 500], [0, 500]] },
  { k: 'dError',   c: D, seq: slow(3) },
];

const TEXT = {
  zh: {
    ledTitle: '追蹤器燈號',
    ledDesc: '下面的圓點會照實際的顏色和節奏閃爍。',
    cols: ['狀態', '燈號', '示範'],
    led: {
      normal: ['正常運作', '每 10 秒亮 0.3 秒'],
      boot: ['每次開機、從待機醒來', '快閃 3 下'],
      shutdown: ['關機', '暗一下後，1 秒內漸漸熄滅'],
      dozeIn: ['進入待機', '紫色快閃 2 下後熄滅'],
      dozing: ['待機中', '不亮'],
      pairing: ['配對模式', '藍色，亮 0.1 秒、暗 0.9 秒'],
      paired: ['配對完成', '綠色快閃 4 下'],
      ping: ['找追蹤器', '白色快閃 10 下'],
      btnHeld: ['按著按鈕', '恆亮'],
      btnAck: ['按鈕動作已接受（更新中按下也是這樣，但動作會被擋下）', '綠色快閃 2 下'],
      holdOff: ['按住準備關機：放開就關機，繼續按住約 5 秒則取消', '0.5 秒亮暗'],
      calStill: ['校正：請保持不動', '青色，0.5 秒亮暗'],
      calRec: ['校正：記錄中', '青色恆亮'],
      calDone: ['校正完成', '綠色快閃 4 下'],
      tcalRun: ['溫度校正收集中（出廠用）', '青色，每 10 秒亮 0.3 秒；開始時立刻亮一下'],
      tcalSlot: ['溫度校正記錄到一格', '青色快閃 2 下（每格約 25 秒以上一次；不閃表示那段被捨棄了）'],
      ota: ['無線更新中（請勿關機）', '橘色快速閃爍，亮 0.1 秒、暗 0.1 秒'],
      otaWait: ['等待其他追蹤器更新（暫時降速讓出頻寬，結束後自動恢復）', '橘色呼吸燈，約 3 秒一次'],
      dfu: ['有線更新模式（快按 4 下進入；按住按鈕 1 秒可關機離開）', '白色恆亮（偏暗）'],
      lowBatt: ['電量低', '橘色微亮閃爍'],
      errSensor: ['錯誤：感測器', '紅色，每 5 秒閃 2 下'],
      errReceiver: ['錯誤：找不到接收器（約 30 秒收不到就出現，約 10 分鐘後轉入待機）', '紅色，每 5 秒閃 3 下'],
      errSystem: ['錯誤：系統（例如電池讀數異常）', '紅色，每 5 秒閃 4 下'],
    },
    dglLedTitle: 'Dongle 燈號',
    dglLed: {
      dNormal: ['正常運作', '每 10 秒亮 0.3 秒'],
      dPairing: ['配對模式', '亮 0.1 秒、暗 0.9 秒'],
      dPaired: ['有追蹤器配對成功', '快閃 2 下'],
      dDozeAll: ['按一下：全部待機', '快閃 2 下'],
      dWakeAll: ['按一下：全部喚醒', '快閃 3 下'],
      dNothing: ['按一下，但沒有可切換的追蹤器（都關機了）', '慢閃 2 下'],
      dHeld: ['按著按鈕', '恆亮；按住超過 1 秒後每秒亮暗交替，方便數秒'],
      dCleared: ['已清除所有配對（按住 5 秒放開，或插上時按住 5 秒）', '快閃 4 下'],
      dRescue: ['按住 10 秒：進入救援模式（UF2）', '慢閃後重新啟動，電腦會出現一個 USB 磁碟機'],
      dError: ['錯誤', '每 5 秒慢閃 2–4 下（請到「診斷」產生報告）'],
    },
    trkBtnTitle: '追蹤器按鈕',
    dglBtnTitle: 'Dongle 按鈕',
    btnCols: ['操作', '作用'],
    trkBtn: [
      ['按一下', '沒有動作；待機中則喚醒追蹤器'],
      ['快按 2 下', '陀螺儀校正（放著不動）'],
      ['快按 3 下', '進入配對模式'],
      ['快按 4 下', '進入有線更新模式（DFU）'],
      ['長按', '關機（放開按鈕後才關）'],
    ],
    dglBtn: [
      ['按一下', '有運作中的追蹤器就全部待機，否則全部喚醒'],
      ['快按 2 下', '結束配對模式'],
      ['快按 3 下', '開始配對模式'],
      ['快按 4 下', '所有追蹤器關機'],
      ['按住 5 秒後放開', '清除所有配對'],
      ['按住 10 秒', '進入救援模式（UF2），用來拖放 .uf2 檔'],
      ['插上電腦時按住超過 5 秒', '清除所有配對'],
    ],
    btnNote: '以上是標準韌體的設定。',
    faqTitle: '常見問題',
    faq: [
      ['追蹤器弄丟或壞了，怎麼從清單移除', '到「管理」頁最下面的「重設與移除」，選那顆追蹤器，按「從 Dongle 移除」。追蹤器不用開機，其他追蹤器的編號不會變。'],
      ['要把追蹤器送人或重新來過', '在「重設與移除」選那顆追蹤器，按「回復出廠」（追蹤器要開機）。會清除校正、電池資料和配對，之後重新配對即可。'],
      ['追蹤器會慢慢飄、方向越來越歪', '到「管理」頁的「校正」：追蹤器全部平放在地上，按「開始校正」等約 10 秒。剛開機的話先等 1 分鐘讓溫度穩定。'],
      ['追蹤器常斷線，或「掃描頻道」每個頻道都是紅色', 'Dongle 可能太靠近 USB 3.0 的連接埠、線材或集線器，它們會干擾整個 2.4 GHz。改插 USB 2.0 連接埠，或用延長線把 Dongle 拉開 30 公分以上。'],
      ['清單顯示「待機」或「關機」', '待機的按一下 Dongle，或在「管理」按「全部喚醒」。關機或不在範圍內的，請把追蹤器拿近 Dongle 並按按鈕開機。'],
      ['無線更新時選不到某顆追蹤器', '可能電量低於 20%（換上新電池或充好的電池就能選）、在待機（按「喚醒並重新檢查」），或型號和韌體不符。'],
      ['更新失敗了', '傳輸中斷不會讓追蹤器變磚，原本的韌體還在，重試即可。把追蹤器放近 Dongle 再試。'],
      ['追蹤器亮橘色呼吸燈，動作變得斷斷續續', '有其他追蹤器正在無線更新，這顆暫時降速讓出頻寬，更新結束後約 10 秒內會自動恢復。沒有在更新卻一直這樣的話，把 Dongle 重新插拔一次；長按按鈕也可以照常關機。'],
      ['Dongle 更新後沒有反應', '到「更新」頁最下方的「Dongle 救援」：按住 Dongle 按鈕 10 秒，把 .uf2 拖進出現的磁碟機。'],
      ['換頻道後有追蹤器沒跟上', '只要是四個匯合頻道（2、24、50、76），它會在約 30 秒內自己找回來；當時關機的，開機後也會找回來。'],
      ['要用什麼瀏覽器', '電腦版 Chrome 或 Edge。手機和 Safari、Firefox 不支援。'],
    ],
  },
  en: {
    ledTitle: 'Tracker lights',
    ledDesc: 'The dots below blink in the real colours and timing.',
    cols: ['State', 'Light', 'Example'],
    led: {
      normal: ['Normal operation', '0.3 s on every 10 s'],
      boot: ['Every power-on, waking from standby', '3 quick blinks'],
      shutdown: ['Power off', 'A moment dark, then a 1 s fade out'],
      dozeIn: ['Entering standby', '2 quick purple blinks, then dark'],
      dozing: ['In standby', 'Off'],
      pairing: ['Pairing mode', 'Blue, 0.1 s on / 0.9 s off'],
      paired: ['Paired', '4 quick green blinks'],
      ping: ['Find my tracker', '10 quick white blinks'],
      btnHeld: ['Button held down', 'Steady'],
      btnAck: ['Button action accepted (also shown during an update, when the action is blocked)', '2 quick green blinks'],
      holdOff: ['Holding to power off: release to switch off, keep holding about 5 s to cancel', '0.5 s on / off'],
      calStill: ['Calibration: hold still', 'Cyan, 0.5 s on / off'],
      calRec: ['Calibration: recording', 'Cyan, steady'],
      calDone: ['Calibration done', '4 quick green blinks'],
      tcalRun: ['Temperature calibration collecting (factory use)', 'Cyan, 0.3 s every 10 s; one flash straight away when it starts'],
      tcalSlot: ['Temperature calibration recorded a slot', '2 quick cyan flashes (about every 25 s or more; none means that stretch was discarded)'],
      ota: ['Wireless update running (do not switch off)', 'Fast orange flashing, 0.1 s on / 0.1 s off'],
      otaWait: ['Waiting while another tracker is updated (slowed down to make room; returns to normal by itself)', 'Orange breathing, about once every 3 s'],
      dfu: ['Wired update mode (press 4 times quickly; hold the button 1 s to switch off and leave)', 'Dim white, steady'],
      lowBatt: ['Low battery', 'Dim orange blinking'],
      errSensor: ['Error: sensor', 'Red, 2 blinks every 5 s'],
      errReceiver: ['Error: no receiver (after about 30 seconds without one; standby after about 10 minutes)', 'Red, 3 blinks every 5 s'],
      errSystem: ['Error: system (e.g. implausible battery reading)', 'Red, 4 blinks every 5 s'],
    },
    dglLedTitle: 'Dongle light',
    dglLed: {
      dNormal: ['Normal operation', '0.3 s on every 10 s'],
      dPairing: ['Pairing mode', '0.1 s on / 0.9 s off'],
      dPaired: ['A tracker paired', '2 quick blinks'],
      dDozeAll: ['Pressed once: standby all', '2 quick blinks'],
      dWakeAll: ['Pressed once: wake all', '3 quick blinks'],
      dNothing: ['Pressed once, nothing to switch (all trackers off)', '2 slow blinks'],
      dHeld: ['Button held down', 'Steady; after 1 s it toggles every second so you can count'],
      dCleared: ['All pairings cleared (hold 5 s and release, or hold 5 s while plugging in)', '4 quick blinks'],
      dRescue: ['Hold 10 s: recovery mode (UF2)', 'Slow blinking, then it restarts and a USB drive appears'],
      dError: ['Error', '2-4 slow blinks every 5 s (make a report under Diagnostics)'],
    },
    trkBtnTitle: 'Tracker button',
    dglBtnTitle: 'Dongle button',
    btnCols: ['Press', 'What it does'],
    trkBtn: [
      ['Once', 'Nothing; wakes the tracker when it is in standby'],
      ['Twice quickly', 'Gyro calibration (leave it still)'],
      ['3 times quickly', 'Pairing mode'],
      ['4 times quickly', 'Wired update mode (DFU)'],
      ['Hold', 'Power off (after you let go)'],
    ],
    dglBtn: [
      ['Once', 'Puts all trackers in standby if any is active, otherwise wakes them all'],
      ['Twice quickly', 'Stop pairing mode'],
      ['3 times quickly', 'Start pairing mode'],
      ['4 times quickly', 'Switch all trackers off'],
      ['Hold 5 s, release', 'Clear all pairings'],
      ['Hold 10 s', 'Recovery mode (UF2), for dropping in a .uf2 file'],
      ['Hold over 5 s while plugging in', 'Clear all pairings'],
    ],
    btnNote: 'These are the standard firmware settings.',
    faqTitle: 'Common questions',
    faq: [
      ['A tracker is lost or broken - how do I take it off the list?', 'At the bottom of the Manage page, open "Reset and remove", pick the tracker and press "Remove from dongle". The tracker does not need to be on, and the other trackers keep their numbers.'],
      ['Giving a tracker away, or starting over', 'In "Reset and remove", pick the tracker and press "Factory reset" (the tracker must be on). Calibration, battery data and pairing are cleared; pair it again afterwards.'],
      ['Trackers slowly drift off their heading', 'Use "Calibration" on the Manage page: lay all trackers flat on the floor, press "Start calibration" and wait about 10 seconds. Right after switching on, give them a minute to warm up first.'],
      ['Trackers drop out, or "Scan channels" shows every channel red', 'The dongle is probably too close to a USB 3.0 port, cable or hub; they disturb the whole 2.4 GHz band. Use a USB 2.0 port, or an extension cable that puts the dongle 30 cm or more away.'],
      ['The list says "Standby" or "Off"', 'For standby, press the dongle button once or "Wake all" under Manage. For off or out of range, bring the tracker near the dongle and press its button.'],
      ['A tracker cannot be selected for a wireless update', 'Its battery may be under 20% (fit a fresh or recharged cell and it becomes selectable), it may be in standby ("Wake and check again"), or its model does not match the firmware.'],
      ['The update failed', 'An interrupted transfer does not brick the tracker - the old firmware is still there. Try again with the tracker closer to the dongle.'],
      ['A tracker breathes orange and its movement turns choppy', 'Another tracker is being updated wirelessly, and this one has slowed down to make room. It returns to normal within about 10 seconds of the update ending. If it stays like this with no update running, unplug the dongle and plug it back in; holding the button still switches the tracker off as usual.'],
      ['The dongle does nothing after its update', 'Use "Dongle recovery" at the bottom of the Update page: hold the dongle button for 10 seconds and drag the .uf2 onto the drive that appears.'],
      ['A tracker did not follow a channel change', 'On the four rendezvous channels (2, 24, 50, 76) it finds its way back within about 30 seconds; one that was switched off does so after it is switched on.'],
      ['Which browser?', 'Desktop Chrome or Edge. Phones, Safari and Firefox are not supported.'],
    ],
  },
  ja: {
    ledTitle: 'トラッカーのランプ',
    ledDesc: '下の丸は実際の色とタイミングで点滅します。',
    cols: ['状態', 'ランプ', '例'],
    led: {
      normal: ['通常動作', '10 秒ごとに 0.3 秒点灯'],
      boot: ['毎回の電源オン、スタンバイからの復帰', '素早く 3 回点滅'],
      shutdown: ['電源オフ', '一瞬消えてから 1 秒かけて消灯'],
      dozeIn: ['スタンバイに入る', '紫で素早く 2 回点滅して消灯'],
      dozing: ['スタンバイ中', '消灯'],
      pairing: ['ペアリングモード', '青、0.1 秒点灯・0.9 秒消灯'],
      paired: ['ペアリング完了', '緑で素早く 4 回点滅'],
      ping: ['トラッカーを探す', '白で素早く 10 回点滅'],
      btnHeld: ['ボタンを押している', '点灯'],
      btnAck: ['ボタン操作を受け付けた(更新中に押した場合も同じですが、操作は無効になります)', '緑で素早く 2 回点滅'],
      holdOff: ['長押しで電源オフ待ち:離すと電源オフ、さらに約 5 秒押し続けるとキャンセル', '0.5 秒ごとに点滅'],
      calStill: ['キャリブレーション:静止', 'シアン、0.5 秒ごとに点滅'],
      calRec: ['キャリブレーション:記録中', 'シアン点灯'],
      calDone: ['キャリブレーション完了', '緑で素早く 4 回点滅'],
      tcalRun: ['温度キャリブレーション収集中(出荷用)', 'シアン、10 秒ごとに 0.3 秒点灯。開始時にすぐ 1 回点灯'],
      tcalSlot: ['温度キャリブレーションが 1 区画記録', 'シアンで素早く 2 回点滅(1 区画あたり約 25 秒以上。点滅しない場合はその区間が捨てられています)'],
      ota: ['ワイヤレス更新中(電源を切らないでください)', 'オレンジで速く点滅、0.1 秒点灯・0.1 秒消灯'],
      otaWait: ['他のトラッカーの更新待ち(一時的に通信を減らして帯域を譲ります。終わると自動で戻ります)', 'オレンジでゆっくり明滅、約 3 秒周期'],
      dfu: ['有線更新モード(素早く 4 回押して入る。ボタンを 1 秒押すと電源オフで抜けられます)', '白で点灯(暗め)'],
      lowBatt: ['電池残量低下', 'オレンジで薄く点滅'],
      errSensor: ['エラー:センサー', '赤、5 秒ごとに 2 回点滅'],
      errReceiver: ['エラー:レシーバーが見つからない(約 30 秒見つからないと表示、約 10 分後にスタンバイ)', '赤、5 秒ごとに 3 回点滅'],
      errSystem: ['エラー:システム(電池の値が異常など)', '赤、5 秒ごとに 4 回点滅'],
    },
    dglLedTitle: 'ドングルのランプ',
    dglLed: {
      dNormal: ['通常動作', '10 秒ごとに 0.3 秒点灯'],
      dPairing: ['ペアリングモード', '0.1 秒点灯・0.9 秒消灯'],
      dPaired: ['トラッカーのペアリング成功', '素早く 2 回点滅'],
      dDozeAll: ['1 回押す:すべてスタンバイ', '素早く 2 回点滅'],
      dWakeAll: ['1 回押す:すべて起動', '素早く 3 回点滅'],
      dNothing: ['1 回押したが切り替える対象がない(すべて電源オフ)', 'ゆっくり 2 回点滅'],
      dHeld: ['ボタンを押している', '点灯。1 秒以上押すと毎秒点滅して秒数を数えられます'],
      dCleared: ['ペアリングをすべて消去(5 秒押して離す、または挿すときに 5 秒押す)', '素早く 4 回点滅'],
      dRescue: ['10 秒押し続ける:復旧モード(UF2)', 'ゆっくり点滅した後に再起動し、USB ドライブが現れます'],
      dError: ['エラー', '5 秒ごとにゆっくり 2〜4 回点滅(「診断」でレポートを作成してください)'],
    },
    trkBtnTitle: 'トラッカーのボタン',
    dglBtnTitle: 'ドングルのボタン',
    btnCols: ['操作', '動作'],
    trkBtn: [
      ['1 回押す', '何もしない。スタンバイ中なら起動'],
      ['素早く 2 回', 'ジャイロのキャリブレーション(静止させる)'],
      ['素早く 3 回', 'ペアリングモード'],
      ['素早く 4 回', '有線更新モード(DFU)'],
      ['長押し', '電源オフ(ボタンを離してから)'],
    ],
    dglBtn: [
      ['1 回押す', '動作中のトラッカーがあれば全部スタンバイ、なければ全部起動'],
      ['素早く 2 回', 'ペアリングモード終了'],
      ['素早く 3 回', 'ペアリングモード開始'],
      ['素早く 4 回', '全トラッカーの電源オフ'],
      ['5 秒押して離す', 'ペアリングをすべて消去'],
      ['10 秒押し続ける', '復旧モード(UF2)。.uf2 ファイルをドロップするため'],
      ['PC に挿すときに 5 秒以上押す', 'ペアリングをすべて消去'],
    ],
    btnNote: '標準ファームウェアの設定です。',
    faqTitle: 'よくある質問',
    faq: [
      ['トラッカーを失くした・壊れた。一覧から消すには', '「管理」ページの一番下の「リセットと削除」でそのトラッカーを選び、「ドングルから削除」を押します。トラッカーの電源は不要で、ほかのトラッカーの番号も変わりません。'],
      ['トラッカーを譲る・最初からやり直す', '「リセットと削除」でそのトラッカーを選び、「工場出荷状態に戻す」を押します(電源が必要)。キャリブレーション・電池データ・ペアリングが消えるので、その後ペアリングし直してください。'],
      ['トラッカーの向きが少しずつずれていく', '「管理」ページの「キャリブレーション」を使います。トラッカーをすべて床に平らに置き、「キャリブレーション開始」を押して約 10 秒待ちます。電源を入れた直後なら、1 分ほど待って温度を安定させてから行ってください。'],
      ['トラッカーがよく切れる、または「チャンネルをスキャン」でどれも赤', 'ドングルが USB 3.0 のポート・ケーブル・ハブに近すぎる可能性があります。これらは 2.4 GHz 帯全体に干渉します。USB 2.0 ポートに挿すか、延長ケーブルで 30 cm 以上離してください。'],
      ['一覧に「スタンバイ」や「電源オフ」と出る', 'スタンバイならドングルのボタンを 1 回押すか、「管理」の「すべて起動」を押します。電源オフまたは圏外なら、トラッカーをドングルに近づけてボタンで電源を入れてください。'],
      ['ワイヤレス更新であるトラッカーを選べない', '電池が 20% 未満(新しい電池か充電済みの電池に交換すれば選べます)、スタンバイ中(「起動して再確認」)、または機種がファームウェアと合っていない可能性があります。'],
      ['更新に失敗した', '転送が途中で止まってもトラッカーは壊れません。元のファームウェアが残っているので、ドングルに近づけてもう一度お試しください。'],
      ['トラッカーがオレンジでゆっくり明滅し、動きがカクカクする', '他のトラッカーをワイヤレス更新中のため、このトラッカーは一時的に通信を減らして帯域を譲っています。更新が終わると約 10 秒以内に自動で元に戻ります。更新していないのに続く場合は、ドングルを挿し直してください。ボタンの長押しでの電源オフは通常どおり使えます。'],
      ['更新後にドングルが動かない', '「更新」ページ下の「ドングルの復旧」を使います。ドングルのボタンを 10 秒押し、現れたドライブに .uf2 をドラッグ&ドロップします。'],
      ['チャンネル変更についてこないトラッカーがある', '4 つの合流チャンネル(2、24、50、76)なら約 30 秒以内に自分で戻ってきます。電源オフだったものも電源を入れた後に戻ります。'],
      ['どのブラウザが使えますか', 'パソコン版の Chrome または Edge です。スマートフォン、Safari、Firefox には対応していません。'],
    ],
  },
};

function keyframes(name, item){
  if (item.breathe){
    return `@keyframes ${name}{0%,100%{opacity:.08}50%{opacity:1}}`;
  }
  const total = item.seq.reduce((a, [, ms]) => a + ms, 0);
  let at = 0, frames = '';
  for (const [lvl, ms] of item.seq){
    frames += `${(at / total * 100).toFixed(3)}%{opacity:${Math.max(0.06, lvl)}}`;
    at += ms;
  }
  frames += `100%{opacity:${Math.max(0.06, item.seq.at(-1)[0])}}`;
  return `@keyframes ${name}{${frames}}`;
}

function duration(item){
  return item.breathe || item.seq.reduce((a, [, ms]) => a + ms, 0);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderHelp(root, lang){
  const T = TEXT[lang] || TEXT.en;
  let css = '';
  const rows = LED.map((item, i) => {
    const name = 'led' + i;
    css += keyframes(name, item);
    const timing = item.breathe ? 'ease-in-out' : 'step-end';
    const dot = item.c
      ? `<span class="ledDot" style="background:${item.c};box-shadow:0 0 0 1px var(--border);animation:${name} ${duration(item)}ms ${timing} infinite"></span>`
      : '<span class="ledDot"></span>';
    const [state, light] = T.led[item.k];
    return `<tr><td>${esc(state)}</td><td>${esc(light)}</td><td>${dot}</td></tr>`;
  }).join('');
  const table = (cols, body) =>
    `<table class="help"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const pairs = list => list.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('');

  const dRows = LED_DONGLE.map((item, i) => {
    const name = 'dled' + i;
    css += keyframes(name, item);
    const dot = `<span class="ledDot" style="background:${item.c};box-shadow:0 0 0 1px var(--border);animation:${name} ${duration(item)}ms step-end infinite"></span>`;
    const [state, light] = T.dglLed[item.k];
    return `<tr><td>${esc(state)}</td><td>${esc(light)}</td><td>${dot}</td></tr>`;
  }).join('');

  root.innerHTML =
    `<style>${css}</style>` +
    `<section class="card"><div class="stepHead"><h2>${esc(T.ledTitle)}</h2></div>` +
    `<p class="desc">${esc(T.ledDesc)}</p>${table(T.cols, rows)}</section>` +
    `<section class="card"><div class="stepHead"><h2>${esc(T.dglLedTitle)}</h2></div>${table(T.cols, dRows)}</section>` +
    `<section class="card"><div class="stepHead"><h2>${esc(T.trkBtnTitle)}</h2></div>${table(T.btnCols, pairs(T.trkBtn))}` +
    `<div class="stepHead" style="margin-top:18px"><h2>${esc(T.dglBtnTitle)}</h2></div>${table(T.btnCols, pairs(T.dglBtn))}` +
    `<p class="desc" style="margin-top:10px">${esc(T.btnNote)}</p></section>` +
    `<section class="card"><div class="stepHead"><h2>${esc(T.faqTitle)}</h2></div><dl class="faq">` +
    T.faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('') +
    `</dl></section>`;
}

export const HELP_LANGS = Object.keys(TEXT);
export const HELP_LED_KEYS = LED.map(l => l.k);
export const HELP_DONGLE_LED_KEYS = LED_DONGLE.map(l => l.k);
export const HELP_TEXT = TEXT;
