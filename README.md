# pi-taskflow-evaluation

Planning と別 Session の Implementation を、確認済み Issue の参照で関連付ける optional Pi Extension / Skill package。**関連付け通知、read-only の候補一覧と Root / 直接子の証拠の JSON / HTML レポート（W1/W2/W3）** を提供します。Evaluation は品質判定、承認代行、Taskflow 完了認定を行いません。

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
5. 後で `/taskflow-evaluate --list` を実行します。事前の集計や report は不要です。現在 cwd / 現在 Session directory の **top-level `.jsonl`** と、同じ scope の検証済み保存 report から候補を発見します。
6. TUI / RPC では `/taskflow-evaluate` で選択（取消は保存なし）。非 UI では `/taskflow-evaluate https://github.com/example/project/issues/1`、`/taskflow-evaluate tickets/2.md`、または `/taskflow-evaluate --taskflow <UUID>` で一意の対象を指定します。無指定・曖昧・探索未完了では保存しません。

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

`--list` は保存 directory / lock を作らず、`jsonCommitted` / `htmlUpdated` は false。集計時は receipt の `taskflowId`、`files.json` / `files.html`、`contentDigest`、warnings / errorCode / resume、`jsonCommitted` / `htmlUpdated` を確認してください。`partial_success` は JSON 更新済み・HTML 更新失敗です。stdout の書込失敗は保存結果と別に command へ伝播し、receipt の再出力で成功に見せません。

## effective settings と読取上限

Tool / command の開始時に `pi.getSettings()` の `taskflow-evaluation.limits` を snapshot し、その操作中は固定します。独自 settings reader / watcher はありません。global / trusted project の項目別 deep merge と precedence は Pi に従います。編集後は `/reload` して再実行してください。

```json
{"taskflow-evaluation":{"limits":{"maxReportJsonMiB":64}}}
```

| key | default | 用途 |
| --- | ---: | --- |
| maxSessionFiles | 2000 | top-level Root 候補数 |
| maxReadMiB | 512 | 操作全体の読取合計（保存確認・変更検証の再読も含む） |
| maxFileMiB | 32 | 一般 Session / 子 Artifact file ごとの上限 |
| maxLineMiB | 2 | JSONL 行ごとの上限 |
| maxRootRuns | 500 | merge 後の Taskflow Root 上限 |
| maxChildrenPerRoot | 100 | W3 の直接子上限 |
| maxExcerptKiB | 16 | 保存テキスト抜粋上限 |
| maxRecords | 20000 | merge 後の証拠件数上限 |
| maxReportJsonMiB | 32 | report.json の再読取・出力上限 |
| maxReportHtmlMiB | 48 | report.html の再読取・出力上限 |

全10項目を検証し、defaults に指定項目だけ重ねます。実際の snapshot を report / receipt の effectiveLimits に示します。直接子の取得対象数には maxChildrenPerRoot、子 Session / Artifact にも共通の読取・抜粋・記録・出力上限を適用します。MiB = 1048576 bytes、KiB = 1024 bytes。正の safe integer と byte 換算を検証し、null / array / string / 0 / negative / fraction / 未知 key / overflow を拒否します。無指定・空 limits は defaults。effective settings 全体や他 namespace / secret は表示しません。

reader は regular file、symlink、path containment、open 後の fstat、v3 header（cwd / custom Session ID を含む）、基本 entry の ID / parent / timestamp、専用 link の version / payload / origin を検証し、bounded chunk で読みます。所属に不要な message role / content / Usage の非対応だけでは有効な関連付けを拒否しません。本文は実際に証拠へ使う field を検証し、非対応部分を unsupported_evidence と表示します。read 開始時の byte 境界より後は採用しません。未知形式、不正行、未完末尾、非通常な変更・短縮、巨大 file/line、候補数/合計byte上限は探索不足として明示し、再計画の reuse を止めます。追記が検出された場合は初期 prefix を再確認し、今回の探索は incomplete として次回の再読を案内します。上限超過時は receipt の key を変更して `/reload` 後に再実行し、原 Session を削除・間引いて解決しないでください。

## Root / 直接子レポートと再集計

固定保存先は `.pi/taskflow-reports/<Taskflow UUID>/report.json`（schemaVersion 1 の正本）と `report.html`（派生）です。別評価 ID / 履歴は作りません。digest field 自体を除いた共通 object の `JSON.stringify` に SHA-256 を適用した contentDigest を JSON / HTML / receipt に含めます。HTML は静的な自己完結ページで、script / CDN / 自動ブラウザ起動はなく、Planning と Issue refs・Issue 別の Root 実行一覧（見つからない Issue は個別表示）を JSON に持ち、見出し・Issue→Root の内部 anchor・keyboard 操作可能な details で辿れます。すべての text / attribute を escape し、外部リンクは検証済み https Issue URL だけです。HTML 単体では最新 JSON との一致を確認できません。

- 実行キーは Root Session ID。同じ Session は更新、同じ Issue の別 Session は別実行です。未集計の Planning / 中間 Implementation も後の集計で取り込みます。
- user request、assistant text の報告、Tool call / result、構造化 exitCode、scope 別 Usage、compaction summary / context_edit、明示子参照を provenance（Session / entry / field / path / timestamp / 取得時点）付きで記録します。独立 marker を含む文章も報告値であり、承認代行や品質判定ではありません。最新報告を実行終了と認定しません。isError=false や成功の文章を exitCode=0 に変換しません。
- system prompt / thinking / signatures / image payload は保存しません。ToolResult.details は bounded JSON-safe な構造を raw Tool 観測として保存し、Review / 承認の status・approved・findings 等も出典から辿れます。Tool-specific schema の意味判断はせず、非 JSON / 過度に深い details や未対応 role / content は取得不足を示します。Root assistant / nested Tool / compaction / usage entry は分け、欠損を0にせず、重複可能な Usage を総合計へ加算しません。直接子は下記の公開参照・親確認・Artifact 検証を満たす範囲だけ取得します。Issue / Plan を network 取得しません。
- immutable な出典キー＋値で dedup。同じ出典の改変は両方と conflict を保持します。消失・短縮・読取不足だけで保存済み観測を削除せず、availability は今回の状態を別に更新します。保存できた quarantine は短縮・消失で通常表示へ戻しません。
- 保存済みの検証済み明示 link proof と今回の有効通知だけを共有 membership index へ統合し、一覧・Issue 選択・Tool の再計画 reuse に使います。旧 unresolved / sourceIssues / add_issues を所属証拠へ昇格せず、pending / 再解決 state を保存・復元しません。所属 conflict は一意としません。保存 container の明示 UUID は所属不明の Root を通常集計へ昇格する根拠にはなりません。
- 読取 budget は一操作共通で、保存 JSON / 既存 HTML の検証読取も含みます。saved JSON は maxFileMiB ではなく **maxReportJsonMiB** で読みます。未知・破損・oversized な正本を空データにして再生成しません。merge 後の Root / records / JSON / HTML overflow は全体を停止し、旧ペアを維持します。抜粋は shortened を明示します。

### 直接子の公開証拠（pi-subagents 0.77.0）

`--list` では子 Artifact を読みません。対象を選んだ集計では、Root の `subagent` / `bg_wait` ToolResult.details と `subagent-notify` CustomMessage.details.runs の明示参照から直接子を取得します。foreground の `details.runId` は wrapper、`results[].index` は安定した子 index、workflow の `results[].runId` / `childRuns[].runId` は子 run ID として区別します。singleton の field と配列 row の field を分け、wrapper の値を子 row の field に付け替えません。子 Session ID / file path は run ID と別です。Session directory の子全探索や、nested 実行の再帰取得はしません。

- 対応する取得元は Pi Session v3、公開 metadata（version field のない 0.77.0 形式）、lifecycle `status.json` version 3、公開 `process-terminal.json` version 1、one-shot result、completion replay / output archive version 1、transcript version 1、managed `_output.md` です。公開結果の task / finalOutput / result、構造化 lifecycle / exit / Usage / acceptance 等と、親確認済み子の request / report / Tool 記録を出典付きで残します。Review は Agent 名・依頼・結果・出典を辿るための報告で、指摘解決や承認の認定ではありません。
- 本文の直接親は `metadata.parentSessionId` と Root Session ID、または子 header の `parentSession` と検証済み Root file path を照合します。UUID と file path を相互に代用しません。両方あって矛盾する場合、双方欠損の場合は通常の子本文として採用せず、親未確認 / conflict と公開結果を区別します。fork は親と確認できる entry ID・観測値の継承 prefix を除外し、帰属不明・検出済み tree navigation を通常本文へ混ぜません。Session を取得できない場合の transcript は親確認済みの非 fork 範囲に限る fallback です。
- 許可範囲は現在 Session directory の Root file stem 配下の参照子 Session と `subagent-artifacts/`、現在 cwd の固定 `.pi/subagents/artifacts/`、現在 environment から確定した user-scoped temp の公開 layout です。Session directory の run folder を wrapper ID と推測せず、明示 sessionFile を使います。temp override は現在の `PI_SUBAGENTS_TEMP_ROOT`、未指定は OS の user scope を使い、公開 asyncDir / archivePath と一致しない過去・独自 root を探索しません。参照 path 自体は読取許可にせず、Artifact 種別・run identity・schema / version、containment / symlink / regular file / fstat を検証します。任意 output override、未知 Artifact 形式・version は取得不足です。
- JSON の `children` と子 provenance の `rootSessionId` / `runId` / `wrapperRunId` / index / Artifact 種別 / field / path を、HTML の Direct children 見出し・details から確認できます。有効な W2 schemaVersion 1 の Root-only JSON も読み取れます。子の証拠は Root 所属の link proof へ昇格しません。
- status の変化は観測値として保持し、running → complete だけで immutable conflict や成功を認定しません。process-terminal proof はプロセスについての観測であり、実行成功・Review 完了と別です。Pi Usage と pi-subagents の `cost: number` / `turns` は別形式として出典 scope ごとに表示し、Root Tool と子・wrapper の値を総加算しません。
- 消失・短縮・期限切れ replay・未完末尾・truncation・非対応本文・読取上限を warnings / availability / shortened で確認してください。保存済み証拠は原ログの消失だけで削除しません。読取開始後の Session / transcript 追記は初期 prefix を再検証して今回の byte 境界までに留め、利用者の次回再集計で取得します。取得不足を成功・Usage 0に置き換えず、独自 pending / 復元再解決・collector・モデル呼出しを追加しません。原ログ / Artifact は変更しません。

### 安全性・復旧

保存 directory は0700、JSON / HTML / temp / lock は0600。親 path、symlink、regular file、open 後 fstat を検証します。Git repository では保存領域の ignore と tracked file 不在を公開 git 操作で確認し、問題があれば停止します。非 Git は notice を出します。Extension は `.gitignore` / index を変更しません。**事前に利用者が `.pi/taskflow-reports/` を ignore してください。**

自由文と構造化 sensitive key の既知 Authorization / Bearer / token / API key / password / URL credential / private key を merge データ全体で秘匿化し、警告します。原ログは変えません。未知秘密を完全に除去する保証はなく、report を公開・外部送信しないでください。上限の引上げは memory / 容量 / 時間を増やします。

排他的 `report.lock` を wx 作成します。外国の lock を stale と推測して削除しません。lock 内で正本を再検証、merge / redaction / limits 検査後、同 directory に両 temp を0600で生成してから JSON rename commit → HTML rename を行います。JSON commit 前の失敗は旧ペアを維持。HTML rename 失敗は rollback せず `jsonCommitted:true / htmlUpdated:false` を返し、次回の同対象再集計で正本から修復します。既存 HTML digest mismatch / unavailable は警告します。電源断耐性・2ファイル同時 atomic 更新は保証しません。

| 停止理由 | 利用者による復旧 |
| --- | --- |
| 読取・merge 上限 | receipt の key を settings で変更し `/reload` 後に再実行。正本削除・間引きで解決しない。JSON 上限だけの引上げで足りなければ maxReadMiB も確認。 |
| JSON 破損・未知 schema | 正常 backup を戻す、または対象 directory を別のユーザー専用・Git 除外済み場所へ手動退避して再生成。消失済み source の証拠は再生成できない。 |
| ignored 不足 / tracked | ignore を利用者が修正し、必要な file を `git rm --cached` で index から外して確認後に再実行。過去 commit / push の秘密は別途失効・履歴対応。 |
| report_busy / 残留 lock | 集計が動いていないことを確認してから手動で report.lock を除去。自動解除・retry はない。 |
| HTML 部分失敗 | 同じ対象で再集計。JSON を削除・rollback しない。 |
| path / permission / settings / redaction 不正 | 該当理由を直して再実行。安全性を無効化する fallback はない。 |

## 制限・未実装

- 一意性は現在 cwd と現在 Session directory の限定 scope の意味です。別 worktree、別 directory、scope 外の矛盾不存在は保証しません。SessionManager.open()/list() は discovery に使わず、原ログを変更しません。
- 未登録の過去会話を自動関連付けしません。未知形式・取得不足・停止・失敗を成功、未実施、Usage 0 に置換しません。
- 記録のない tree navigation の完全な履歴は復元できません。正常な取得で検出した派生 header / branch_summary / parent 飛び / 複数 roots / 現在 leaf 不一致は quarantine に保持し、別枝の成果・Review・承認を通常集計から外します。duplicate entry / parent 欠損 / duplicate Session ID 等で取得未完了になった場合は検出理由を receipt に示して保存停止し、旧ペアを維持します。未更新の操作の観測を独自復旧 state として保存しません。
- **W3 の取得限界:** 完全な nested 階層、任意 output override、期限切れ・消失済み Artifact、親や fork 帰属が確認できない通常本文は取得できません。非対応 field の不足だけで有効な Root の明示所属を失わせません。
- **W4:** 隣接 pi-taskflow Skills の optional 通知接点は未実装。現段階では上記 Tool を直接使います。
- Extension に network / model / browser / 独自永続 state はありませんが、原 Session には利用者が通知した参照と displayName が保存されます。秘密を入力しないでください。

## 検証

```sh
pnpm exec vitest run tests/taskflow-evaluation.test.ts
pnpm check
# 公開 SDK / loader を使う model なしの probe（同じ公開入口を直接操作）
pnpm exec vitest run tests/taskflow-evaluation.test.ts -t 'public Pi loader'
```

tests は temporary SessionManager fixtures と公開 Tool execute / command handler を使い、保存・再発見・union・再計画・fork・cwd・上限・append 故障を確認します。実 Pi CLI の text / JSON mode も temporary cwd / agentDir / Session directory と offline で各3回実行します。負荷条件は100 Planning + 100 Implementation Sessions、Issue refs は全体で100件（各 Planning に異なる1件と対応する1 Implementation）です。候補・Issue・Session の集合と所属、欠落・重複なし、末尾 LF・完全な一行 JSON、stderr 非混入、原ログ不変、受信 bytes / 時間を確認し、遅い pipe reader と file redirect も含めます。書込境界では完了待ち・stdout 再利用・同期 throw / callback error / stream error の伝播と listener の後始末を確認します。settings defaults と通常・境界・異常 fixture は縮小しません。旧2000 Sessions / 100000 refs の約18 MB receipt では EAGAIN / ERR_SYSTEM_ERROR による途中切断の観測があり、旧規模は修正済み・検証済み・保証済みとは扱いません。SDK probe は `DefaultResourceLoader` に `src/index.ts` を明示し、登録 Tool を公開 `extensionRunner.createToolContext()` で実行、`session.prompt('/taskflow-evaluate --list')` で receipt を取得します。temporary SettingsManager で untrusted/trusted project、global/project merge、公開 `session.reload()` を確認し、ModelRuntime の model request 境界を throw/count して request 0 を検証します。W2 tests は登録 command から実 temp file に集計し、保存 ownership、改変 conflict / 消失 / 短縮 / quarantine、redaction / schema / Git / symlink / lock / temp・rename 故障 / limits を確認します。公開 SDK prompt と実 CLI text / JSON で report receipt と原ログ不変・no-model を確認します。UI の select/cancel は公開 TUI/RPC UI 境界で stub 検証しており、実 terminal / RPC・ローカルブラウザの keyboard 動作や実運用の concurrent filesystem 変更すべてを検証したという意味ではありません。閉 pipe では command の EPIPE reject 伝播と、Pi 1.1.0 自身の終了時 flush の未処理 EPIPE を区別します。後者は Pi 本体の範囲であり、この Extension の修正保証には含めません。

W3 tests は登録 command seam から foreground / background / workflow の公開 fixture を集計し、親 ID / path の欠損・矛盾、fork prefix、危険 path / symlink、未知 version / identity、期限切れ・消失、非対応本文、status 変化、dedup / immutable 改変、共通上限・秘匿化・保存済み W2 形式を確認します。合成 fixture の検証と実子の公開ログを隔離コピーして公開 SDK command で集計する確認は区別します。実子起動、実 TUI / RPC / browser の操作や独立 Review gate は unit tests の成功だけで検証済みとはしません。
