# pi-taskflow-evaluation

Planning と別 Session の Implementation を、確認済み Issue の参照で関連付ける optional Pi Extension / Skill package。現在提供するのは **関連付け通知と read-only の候補一覧（W1）** です。Evaluation は品質判定、承認代行、Taskflow 完了認定を行いません。

## 導入

Pi 1.1.0 / Session format v3 で検証しています。ローカル checkout で `pnpm install` 後、次のどちらかを使います。

```sh
# 今回だけ Extension を読み込む（設定を書き換えない）
pi -e /absolute/path/pi-taskflow-evaluation/src/index.ts

# Extension と Evaluation Skill を package として導入
pi install /absolute/path/pi-taskflow-evaluation
```

`pi install --local ...` は project の `.pi/settings.json` に追加します。project package/settings は Pi の project trust が有効な場合だけ読み込まれます。Extension は Pi と同じ OS 権限で実行されるので、導入前にコードを確認してください。編集後は `/reload`。未導入・非アクティブ・通知失敗でも、既存 Taskflow の進行・個別承認条件を変えず、代替 manifest を作りません。

## 段階的な利用

1. 新しい Root Session で通常の user message を保存してから、モデルに提示されている direct Tool `taskflow_evaluation_link` を使います。新規 pending Session はまだ原ファイルがなく、CustomEntry だけでは保存されません。in-memory Session も拒否します。
2. Planning の目的が確認できたら `begin_planning`。再計画だけ `sourceIssues` に取得確認済みの既存 Issue refs を渡します。
3. 保存・公開承認後、作成または再利用を確認できた Issue だけ `add_issues`。部分作成の場合も確認済みの部分だけ通知します。
4. 別の新しい Root Session で対象 Issue を取得確認したら `implementation`。同じ Issue の別 Session は別実行です。
5. 後で `/taskflow-evaluate --list` を実行します。事前の集計や report は不要です。現在 cwd / 現在 Session directory の **top-level `.jsonl`** だけから候補を発見します。

Tool 入力例（Taskflow ID は入力しません）:

```json
{"operation":"begin_planning","displayName":"配送機能"}
{"operation":"add_issues","issues":["https://github.com/example/project/issues/1","tickets/2.md"]}
{"operation":"implementation","issue":{"kind":"github","host":"github.com","owner":"example","repo":"project","number":1}}
{"operation":"begin_planning","displayName":"配送の再計画","sourceIssues":["https://github.com/example/project/issues/1"]}
```

GitHub は credential / query / fragment / port のない https Issue URL、または上記の明示構造です。host / owner / repo は小文字で照合し、number は正の safe integer。番号だけ・タイトル・会話の意味では対応を推測しません。local は既存の regular ticket file を指す project-relative path、または `{"kind":"local","path":"tickets/2.md"}`。cwd containment を確認し、絶対 path、`..`、symlink escape を拒否します。Tool は Issue / ticket 本文を読まず、network 取得もしません。

固定入力制限は displayName 160文字、1通知あたり refs 100件、CustomEntry 全体 64 KiB（UTF-8、metadata の余裕を含めて事前検査）。これらは settings で緩和できません。保存形式は `customType: pi-taskflow-evaluation.link` / payload `version: 1`、`originSessionId`、phase、operation、必要な参照だけです。

### 保存確認と再試行

- `status: saved` は原 Session ファイルの有効な entry を読んで確認した結果です。memory や file path の存在だけでは成功にしません。
- 同じ通知は冪等。Planning の Issue 追加は union で、削除しません。同じ Session の phase、Implementation Issue、Planning の Taskflow/目的/sourceIssues の切替は拒否します。
- fork のコピーは `originSessionId !== header.id` なので所属証拠から除外します。矛盾した原記録は削除・上書きせず、不足として表示します。
- `save_unconfirmed` / append 失敗では、保存済みと見なさないでください。部分成功の有効 entry が原ファイルにあれば、再試行で duplicate saved を返します。現在の leaf が原ファイルで確認できない場合は、memory-only の通常 message / CustomEntry とも Evaluation の追加を停止します。Pi の通常の reload/resume で原 Session の保存状態を確認してから再試行してください。Extension は原ログの補修・独自 flush をしません。
- 再計画は、全 sourceIssues の明示対応が現在の限定探索で一意かつ同じ Taskflow の場合だけ既存 UUID を使います。不明・一件不足・複数所属・異所属・探索未完了は `planning_source_issues_unresolved` を返し、CustomEntry・独自 pending 状態を追加せず、**新 UUID を発行して回避しません**。後日、明示対応が得られた場合は利用者による通常の通知で既存 ID を再利用できます。自動再試行・再解決はありません。
- 正規の旧 version 1 unresolved begin は読取専用の対応未記録として区別します。その sourceIssues / add_issues は所属証拠へ昇格せず、別の明示対応を block しません。旧 Session の begin 再通知 / add_issues は `planning_legacy_unresolved`、phase 切替は `phase_switch_refused` として追加を拒否し、原記録の再保存・ID 補完・移行をしません。不正な旧形・未知 version は採用しません。

## `/taskflow-evaluate --list`

`waitForIdle()` 後に読み取ります。TUI / RPC では UI 通知、UI がない print / JSON mode では stdout に `TASKFLOW_EVALUATION_RESULT ` prefix 付きの一行 JSON receipt を出します。Pi の instance `write` redirect を避けるため、公開 `Writable.prototype.write.call(process.stdout, receiptLine, callback)` で一行と末尾 LF を一回書き、callback を待ちます。stdout の変更・end / destroy / close、独自 retry / queue は行いません。同期 throw・callback error・stream error は command の呼出元へ伝播します。callback は chunk の処理完了であり、受信側の読了 ACK や永続化保証ではありません。新しい model request / `sendUserMessage` / 会話メッセージの追加はありません。

receipt の `candidates` は displayName / Planning 日時 / Issue refs（取得済みの `sourceIssues` と `add_issues` の union）/ Planning・Implementation Session IDs、`unresolved` は未登録・所属不明候補です。`conflicts` は同一 Issue に複数の明示 Taskflow ID が見つかった場合の Issue / Taskflow IDs を示し、どちらも削除・上書きしません。その Issue の一意所属や再計画の reuse は認定しません。`complete: false` なら一意所属を確定しません。`warnings` は超過 key / 設定値 / retry 条件、`sourceWarnings` は fork / 記録された navigation 等の制限です。`missingImplementationIssues` は「実行記録が見つからない」であり、未実施の認定ではありません。CLI exit code や RPC prompt handled を成功証拠にしないで、receipt を確認してください。

現在は `--list` 以外を `list_only` として返し、report を保存しません。receipt の `jsonCommitted` / `htmlUpdated` は常に false。Issue 指定・選択 UI・HTML 出力を利用可能とは案内しません。

## effective settings と読取上限

Tool / command の開始時に `pi.getSettings()` の `taskflow-evaluation.limits` を snapshot し、その操作中は固定します。独自 settings reader / watcher はありません。global / trusted project の項目別 deep merge と precedence は Pi に従います。編集後は `/reload` して再実行してください。

```json
{"taskflow-evaluation":{"limits":{"maxReportJsonMiB":64}}}
```

| key | default | 用途 |
| --- | ---: | --- |
| maxSessionFiles | 2000 | top-level Root 候補数 |
| maxReadMiB | 512 | 操作全体の読取合計（保存確認・変更検証の再読も含む） |
| maxFileMiB | 32 | Session file ごとの上限 |
| maxLineMiB | 2 | JSONL 行ごとの上限 |
| maxRootRuns | 500 | W2 の Taskflow Root 上限 |
| maxChildrenPerRoot | 100 | W3 の直接子上限 |
| maxExcerptKiB | 16 | W2 の抜粋上限 |
| maxRecords | 20000 | W2 の証拠件数上限 |
| maxReportJsonMiB | 32 | W2 の report.json 上限 |
| maxReportHtmlMiB | 48 | W2 の report.html 上限 |

全10項目を検証し、defaults に指定項目だけ重ねます。W2/W3 用項目も receipt に effectiveLimits として示しますが、W1 に report/child 処理はありません。MiB = 1048576 bytes、KiB = 1024 bytes。正の safe integer と byte 換算を検証し、null / array / string / 0 / negative / fraction / 未知 key / overflow を拒否します。無指定・空 limits は defaults。effective settings 全体や他 namespace / secret は表示しません。

reader は regular file、symlink、path containment、open 後の fstat、v3 header（cwd / custom Session ID を含む）、基本 entry の ID / parent / timestamp、専用 link の version / payload / origin を検証し、bounded chunk で読みます。所属に不要な message role / content / Usage の非対応だけでは有効な関連付けを拒否しません。本文を証拠として扱う検証は W2/W3 の範囲です。read 開始時の byte 境界より後は採用しません。未知形式、不正行、未完末尾、非通常な変更・短縮、巨大 file/line、候補数/合計byte上限は探索不足として明示し、再計画の reuse を止めます。追記が検出された場合は初期 prefix を再確認し、今回の探索は incomplete として次回の再読を案内します。上限超過時は receipt の key を変更して `/reload` 後に再実行し、原 Session を削除・間引いて解決しないでください。

## 制限・未実装

- 一意性は現在 cwd と現在 Session directory の限定 scope の意味です。別 worktree、別 directory、scope 外の矛盾不存在は保証しません。SessionManager.open()/list() は discovery に使わず、原ログを変更しません。
- 未登録の過去会話を自動関連付けしません。未知形式・取得不足・停止・失敗を成功、未実施、Usage 0 に置換しません。
- 記録のない tree navigation の完全な履歴は復元できません。検出した fork/分岐は sourceWarnings に表示しますが、W1 は本文の通常集計をしません。
- **W2:** report JSON/HTML 生成、保存済み report の所属統合、秘匿化、安全保存、復旧は未実装。
- **W3:** 直接子の本文・Artifact 取得は未実装。
- **W4:** 隣接 pi-taskflow Skills の optional 通知接点は未実装。現段階では上記 Tool を直接使います。
- Extension に network / model / browser / 独自永続 state はありませんが、原 Session には利用者が通知した参照と displayName が保存されます。秘密を入力しないでください。

## 検証

```sh
pnpm exec vitest run tests/taskflow-evaluation.test.ts
pnpm check
# 公開 SDK / loader を使う model なしの probe（同じ公開入口を直接操作）
pnpm exec vitest run tests/taskflow-evaluation.test.ts -t 'public Pi loader'
```

tests は temporary SessionManager fixtures と公開 Tool execute / command handler を使い、保存・再発見・union・再計画・fork・cwd・上限・append 故障を確認します。実 Pi CLI の text / JSON mode も temporary cwd / agentDir / Session directory と offline で各3回実行します。負荷条件は100 Planning + 100 Implementation Sessions、Issue refs は全体で100件（各 Planning に異なる1件と対応する1 Implementation）です。候補・Issue・Session の集合と所属、欠落・重複なし、末尾 LF・完全な一行 JSON、stderr 非混入、原ログ不変、受信 bytes / 時間を確認し、遅い pipe reader と file redirect も含めます。書込境界では完了待ち・stdout 再利用・同期 throw / callback error / stream error の伝播と listener の後始末を確認します。settings defaults と通常・境界・異常 fixture は縮小しません。旧2000 Sessions / 100000 refs の約18 MB receipt では EAGAIN / ERR_SYSTEM_ERROR による途中切断の観測があり、旧規模は修正済み・検証済み・保証済みとは扱いません。SDK probe は `DefaultResourceLoader` に `src/index.ts` を明示し、登録 Tool を公開 `extensionRunner.createToolContext()` で実行、`session.prompt('/taskflow-evaluate --list')` で receipt を取得します。temporary SettingsManager で untrusted/trusted project、global/project merge、公開 `session.reload()` を確認し、ModelRuntime の model request 境界を throw/count して request 0 を検証します。実 TUI/RPC UI と実運用の concurrent filesystem 変更すべてを検証したという意味ではありません。閉 pipe では command の EPIPE reject 伝播と、Pi 1.1.0 自身の終了時 flush の未処理 EPIPE を区別します。後者は Pi 本体の範囲であり、この Extension の修正保証には含めません。
