# Taskflow の関連付け・事後集計・ローカルレポート（契約簡略化改訂）

## 目的

`docs/designs/taskflow-evaluation.md` と既存の Approved Plan を基に、W1 の未コミット実装で増えた契約を、明示的な関連付け通知と事後集計に必要な範囲へ簡略化する。Planning と複数 Issue の Implementation を一つの Taskflow として振り返れる optional Pi Extension / Skill package という目的は変えない。既存ログから依頼・実施・報告・検証・Review・停止理由とその出典を整理し、報告されたこと、直接記録されたこと、取得できないことを区別する。

Evaluation は正しさ・品質・工程の十分性を判定しない。LLM Judge、新しいモデル呼び出し、承認の代行、Taskflow 完了の認定は行わない。

今回の限定改訂は、ユーザーの依頼による W1 の負荷検証条件の縮小と CLI 出力の具体的な stream API 固定の見直しだけを目的とする。関連付け契約の簡略化を含む他の要件、W2 / W3 / W4 の機能範囲・分割・依存は維持する。現方式の修正には必ず Plan 変更が必要だったという理由ではなく、その断定は撤回済みとする。

## 要件・決定事項

- Planning と各 Implementation は別の新しい Root Session。一つの Root Session は一回の実行を扱う。実行キーは Root Session ID。同じ Issue の別 Session は別実行、同じ Session の再集計は更新とする。
- Issue は GitHub の hostname / owner / repository / issue number、または対象 cwd 内の正規化した local ticket path で識別する。番号だけ・タイトル・時刻・会話の意味から所属を確定しない。
- 再計画は、入力の既存 Issue の明示的な所属がすべて一意かつ同じ Taskflow の場合だけ既存 ID を再利用する。所属なし・矛盾・複数候補・探索未完了では、その通知の関連付け CustomEntry を追加せず、理由だけ返す。独自の unresolved 登録・保存待ち・自動再解決・復旧工程を持たず、新 UUID の発行でも回避しない。過去の unresolved グループにある別 Issue の不明状態を、今回の明示対応の利用を妨げる条件にしない。
- 自動発見は現在の cwd と現在の Session directory に限定する。header.cwd も照合する。別 worktree、別 Session directory、過去の異なる temp root は横断しない。
- `../pi-taskflow` の Planning / ticket / Implementation Skill への最小の optional 通知追記も実装範囲とする。未導入・非アクティブ・通知失敗は入力・進行・承認条件を変えず、独自の代替記録を作らない。
- 関連付け Tool と手動集計 command の二つの公開 seam で TDD を使う。
- レポートは `.pi/taskflow-reports/<taskflowId>/report.json` と `report.html`。JSON を正本、HTML を同じデータから生成する派生成果物とする。独立した評価 ID・評価履歴は作らない。
- 保存済みの証拠は原ログの消失だけで削除しない。現在の取得状態・通常表示の可否は証拠から見直し、所属は保存済みと今回取得した有効な明示対応だけから計算する。これは未関連付け通知の保存・復元・再解決ではない。
- 固定2ファイルの同時 atomic 更新は保証しない。JSON commit 後の HTML 更新失敗は部分成功として通知し、次回再集計で修復する。
- 上限は `settings.json` の `taskflow-evaluation.limits` で項目単位に変更できる。無指定では本 Plan のデフォルトを使う。

## 制約・対象外

- 実行中 collector、queue、workflow state、収集の停止・再開、独自 Agent / tracker / 子実行管理は追加しない。
- Pi / pi-subagents の実行・ログ保存、原ログ、Issue / Plan / 対象コードを集計で変更・削除しない。関連付け CustomEntry の追加だけを行う。
- 旧 Evaluation 保存形式の互換・移行、過去の未登録会話の自動関連付け、所属補正と補正履歴、Plan 全文の専用保存・hash 照合・版管理、Git snapshot、厳密な Timeline、品質スコア、完全な Usage 合計は対象外。
- 会話 tree の巻き戻し・分岐を含む実行の通常集計、完全な nested 実行階層、任意 output override のファイル取得は対象外。検出した制限を表示する。
- 秘密専用ファイル・認証設定の追加読取、外部送信・公開・ブラウザ自動起動、削除機能・保存期限管理は提供しない。
- 新規 dependency、独自設定ファイル、設定を変更する Tool、追加の Draft 管理・manifest・世代 directory は作らない。既存 TypeScript / TypeBox / Vitest / Node 標準機能を使う。
- 今回の Planning は既存 Approved Plan と既存 Work Items の必要最小限の更新・保存・公開で終了する。重複 Issue・追加の機能 Work Item を作らず、production code・テスト・基本設計・README・Skill の既存差分を変更・削除・format・stage・commitしない。production code の実装、Worker 起動、merge / release / deploy は別セッションの別許可による。
- 新しい CLI 出力上限・ページング・候補の省略、settings 探索上限 defaults の変更は今回の改訂に含めない。独自 retry / queue / 出力基盤、新規 dependency、第三者 patch、runtime private API を追加しない。

## 確認した事実と限界

今回の対象 checkout は `pi-taskflow-evaluation` の `23a8624`。正式 Issue #1 の埋め込み Plan と改訂前の正式ファイルは全文・SHA-256 が一致した。W1 の `src/`、README、Skill、主テストは未追跡、`tests/smoke.test.ts` と正式 Plan は既存差分として存在する。隣接 `pi-taskflow` は `0a7469d` で、Planning / Implementation Skill に既存未コミット差分がある。両 repository の既存差分を保持し、今回の Plan 更新以外は変更・削除・format・stage・commitしない。

現コード・テスト・正式 Issue 本文を今回改めて確認した。根拠は `src/contracts.ts` の linkSchema / validLink、`src/index.ts` の登録 Tool / command、`src/discovery.ts` の readRun / membershipIndex / candidateList、公開入口テスト、README / Evaluation Skill、package scripts、および末尾の正式 Work Item 参照。過去の会話・Scout 出力・一時 Probe artifact を Implementation の入力にしない。

- 現 W1 の `src/contracts.ts` / `src/discovery.ts` / `src/index.ts` / `tests/taskflow-evaluation.test.ts` には、新規 unresolved 非保存、正規の旧 unresolved の読取専用識別、旧グループの所属昇格・block の削除、不要な会話詳細検証の削除という部分差分がある。一覧の取得不足表示と明示対応の conflict 表示は維持するが、部分実装を完了済みと扱わない。
- memory-only leaf への追加停止、append 前後の原ファイル確認、操作ごとの所属 index は維持する。CLI は現在 fd 1 の `fs.createWriteStream` / `finished()` を使うが、この具体的 API の維持は要求しない。package / export と smoke の追加変更は不要。
- 前回 Root checks では大 receipt の JSON parse 失敗があり、単独再実行の成功は完了根拠にならない。その後の Worker typecheck と一度の focused suite は成功との引継ぎがあるが、CLI 反復検証は失敗した。文書整合、追加回帰、変更後の Root checks・直接検証、独立した2 Review、Code Review gate は未完了で、後の Implementation で改めて行う。今回の Planning では production suite を実装完了の根拠として実行しない。
- 旧 CLI fixture は1000 Planning + 1000 Implementation の2000 Session 候補と100000 Issue refs（各 Planning に100件）を使う。Node v24.21.0 の実 Pi CLI で約18 MBの候補一覧が途中切断し、`fs.WriteStream` の EAGAIN 反復から ERR_SYSTEM_ERROR となり `finished()` が reject したとの観測がある。観測例は stdout 13,500,416 bytes・末尾 LF なし、stderr command error、CLI exit 0で、この再現は header の途中混入ではない。完了待ちの reject 自体は正常な失敗通知であり、握りつぶさない。旧規模は検証済み・保証済み・修正済みとは扱わない。
- 今回の一時 Probe（Node v24.21.0 / Pi 1.1.0）は出力方式だけを検証した。公開 `Writable.prototype.write` を既存 stdout に適用し、遅い pipe の合成約18 MBを3回、byte 数・hash・末尾 LF と後続書込で確認した。隔離した実 Pi CLI text / JSON mode でも18,000,039 bytesの合成 receipt の完全性・JSON parse・stderr 非混入を確認した（JSON mode の独立した Session header 行は receipt と区別）。file / TTY の小さな出力と stdout 再利用、Node 単体の閉 pipe による reject / EPIPE も確認した。実 Pi の閉 pipe は command error を通知した後、Pi 自身の flush でも未処理 EPIPE が発生した。Pi 本体の修正は今回の範囲外とする。これらは現在の候補一覧や旧規模の切断問題の修正完了を証明しない。
- 実 TUI / RPC、実子本文、レポート安全保存は今回の検証対象外で、後続 Work Item の完了条件に残す。

Pi 1.1.0 / Session format v3、pi-subagents 0.77.0 の対応範囲と公開 API の利用は従来 Plan のまま。未記録 navigation の完全復元を約束しない。W2/W3 は実装時に必要な公開資料・実ログを再確認し、未確認形式を対応済みとしない。

## 実装方針

### 1. 関連付け契約

`src/index.ts` の Extension に direct Tool `taskflow_evaluation_link` を登録する。以下の3操作を schema で区別し、Root が呼ぶ。Taskflow ID をユーザーに覚えさせない。

| operation | 入力 | 動作 |
|---|---|---|
| begin_planning | displayName、必要な場合だけ sourceIssues | 新規なら UUID を発行。再計画は明示対応を確認して既存 ID を再利用。未確定なら追加せず理由を返す |
| add_issues | 作成・取得確認済みの Issue refs | 同じ Planning 実行へ対応を追加。部分作成なら確認できた項目だけ通知。未作成 Issue を推測しない |
| implementation | 取得確認済みの対象 Issue ref | Implementation と対象を登録。Taskflow ID は受け取らず、集計時に Planning の対応から解決 |

CustomEntry の customType は `pi-taskflow-evaluation.link`。version 1 の最小 payload は originSessionId、phase、operation に必要な taskflowId / displayName / issues / sourceIssues。新規書込の begin_planning は taskflowId 必須で、unresolved reason は保存しない。cwd と Root ID は context / header から取得し、originSessionId は fork のコピー排除のため保存する。Plan 本文・進行状態・保存待ち情報は入れない。displayName は最大160文字、Issue refs は1回最大100件、entry は最大64 KiBとする。これらは固定入力制限で、レポート上限設定とは別。

同じ origin の同じ通知は冪等。Planning の Issue 追加は集合の union とし削除しない。同じ Session の別 phase / 別 Implementation Issue / 異なる Taskflow への切替は拒否し、正常な別実行を作らない。origin が header と異なるコピー entry は所属証拠に採用しない。矛盾は削除・上書きで消さず表示する。

GitHub は https の Issue URL または明示構造から host / owner / repository / 正の issue number を検証する。host は小文字、owner / repository は GitHub の識別規則に沿って照合する。local は現在 cwd 内の project-relative ticket path で識別し、traversal / symlink escape を拒否する。Issue / ticket 本文はこの Tool では再取得しない。

Tool は通知前に入力・既存登録・永続化可能な Session を検証する。現在の leaf が null でない場合、原 Session ファイルに同じ entry ID があることを確認できなければ Evaluation の追加だけを停止する。通常 message でも CustomEntry でも同じで、memory にあることや file path の存在を保存証拠にしない。独自 queue / flush / 修復 / 自動再試行は追加しない。

appendEntry 後は原ファイルの有効な対応 entry で保存を確認する。書込失敗後も memory だけを成功とせず、partial append の利用者による再通知は原ファイルを照合して二重登録しない。非永続・未登録・保存未確認・関連付け不能は結果として通知するだけで、Taskflow 本体の進行・承認は止めない。

再計画は限定探索と検証済みの明示対応だけを使う。scan ごとに Issue → Taskflow の対応表を一度構築し、Tool と候補一覧は同じ全件一意・同一 ID の規則を使う。`src/discovery.ts` の membershipIndex から unknown グループの収集・再解決・blocked 集合を削り、index 自体は残す。Implementation ごとの Planning 全再探索へ戻さず、永続 cache / global state / 新設定を追加しない。必要な探索が未完了なら reuse しない。「一意」は限定 scope 内の意味で、scope 外の矛盾不存在は保証しない。

過去の正規の version 1 unresolved begin は、対応未記録の原記録として厳密に識別するが、所属証拠・再解決対象にしない。その Session の sourceIssues / add_issues を所属へ昇格させず、別の明示対応を block するグループも作らない。元の schema・XOR・Issue 正規化・header / entry / origin 検証を通る旧形だけを区別し、未知 version、不正 payload、taskflowId と unresolved の両立等は救済しない。旧 begin は phase / conflict 判定に必要な範囲で認識し、読み捨てによる孤立 add_issues を作らない。旧 Session の begin 再通知 / add_issues は追加せず、旧 entry の再保存・ID 補完・phase 切替も行わない。移行・補正・汎用互換基盤は作らず、原記録は保持する。

### 2. Taskflow Skill の通知接点

隣接 repository の以下だけに通知手順を追記する。第三者の導入済み Skill、global 設定、Extension 配線は変更しない。

- taskflow-planning：目的と新規 / 再計画対象が確認できた時点で begin_planning。再計画 sourceIssues は通常取得して確認した参照を使う。Approved Plan と正式パスを ticket Skill に渡す際に、利用可能な通知の契約を渡す。
- taskflow-to-ticket：ユーザーの保存・公開承認後、各 Issue / local ticket の作成・取得確認後に add_issues。既存同一チケットの再利用と部分作成にも確認済み refs を通知する。未承認・下書き・未確認の番号を登録しない。
- taskflow-implementation：対象 Work Item の取得先・識別が確認できた時点で implementation。Worker 起動前に行い、その後 BLOCKED / REPLAN_REQUIRED になった実行も識別可能にする。

各 Skill は通知 Tool がモデルに提示され利用可能な場合だけ呼ぶ。不可・失敗・呼び忘れ・再計画の関連付け不能でも Taskflow を停止したり、承認を変更したり、代替 Tool / manifest を作らない。通知不能のための保存待ち・再解決工程や新 UUID 回避を Skill に追加しない。begin が保存されていない場合も後続 Taskflow 手順は継続し、add_issues の拒否を補修しない。登録前に停止した実行は欠損として扱う。Plan / tracker 設定 / 分割 / 保存公開の個別承認手順は維持する。

### 3. 設定と上限

`pi.getSettings()` の `taskflow-evaluation.limits` だけを検証して利用する。defaults に effective settings の指定項目だけを重ねる。Tool / command 開始時に snapshot を取り、処理中は固定する。設定編集後は Pi の `/reload` で反映する。独自 watcher / settings reader / SettingsManager は追加しない。

| key | default | 意味 |
|---|---:|---|
| maxSessionFiles | 2000 | 所属探索で調べる Root Session 候補ファイル数 |
| maxReadMiB | 512 | 1回の操作で読むログ・Artifact・保存済み JSON の合計 |
| maxFileMiB | 32 | 一般ログ・Artifact 1ファイルの読取上限 |
| maxLineMiB | 2 | JSONL 1行の上限 |
| maxRootRuns | 500 | 一つの Taskflow に含める Root 実行数 |
| maxChildrenPerRoot | 100 | Root ごとの取得対象の直接子実行数 |
| maxExcerptKiB | 16 | 各保存テキスト抜粋の UTF-8 byte 上限 |
| maxRecords | 20000 | Taskflow ごとの保存証拠レコード数 |
| maxReportJsonMiB | 32 | report.json の出力・再読取上限 |
| maxReportHtmlMiB | 48 | report.html の出力上限 |

MiB = 1048576 bytes、KiB = 1024 bytes。値は正の safe integer とし、byte 換算も safe integer の範囲で検証する。null / array / 文字列 / 0 / 負数 / 小数 / 未知の項目を拒否する。無制限指定は提供しない。無指定・空 limits は defaults。設定 namespace 全体や他の settings 値をレポート・エラーに出さない。実際に使った上限値だけをレポートへ残す。

例：`{"taskflow-evaluation":{"limits":{"maxReportJsonMiB":64}}}` は JSON 上限だけ変更する。保存済み report.json の読取には一般 maxFileMiB ではなく maxReportJsonMiB を適用する。maxReadMiB の合計にも達した場合は、その設定も変更する必要がある。設定を低くした結果、既存 JSON を読み取れない場合は更新を停止し、間引かない。

候補数・容量の読取上限は取得不足として明示する。関連付けに必要な構造・記録を検証できない、または探索が未完了なら一意所属を確定しない。所属判定に使わない会話内容の非対応だけでは、有効な関連付けを拒否しない。証拠として検証できない本文を通常実行の成果として説明しない。EOF の未完行は確定 entry とせず次回の利用者操作で再読する。出力・Root 数・証拠件数の merge 後上限超過は更新全体を停止し、既存 JSON / HTML を保持する。新規分の選別保存や旧証拠の間引きはしない。エラーには超過項目・設定値・変更キー・未反映範囲・再開条件を示す。

### 4. 発見と read-only 集計

現在の Session directory の top-level JSONL 候補と `.pi/taskflow-reports/` の検証済み保存結果だけを bounded に列挙・読取する。無関係な project directory や子 Artifact を全探索しない。header.cwd、Session ID、CustomEntry schema / origin を検証して候補を作る。Session ID は Pi が custom ID も許すため UUID 固定検証にしない。出力 directory の Taskflow ID は Extension が発行した UUID のみ許す。

Pi Session format v3 と pi-subagents 0.77.0 の文書化された公開 file / result 契約を初版の対応範囲とする。runtime private import / registry / 他 Session の RPC status を使わない。W1 は安全な読取、対応 header の version / ID / cwd、entry の ID / parent 等の基本構造、専用 CustomEntry の version / payload / origin と矛盾を検証する。所属判定に不要な message role / content / Usage の詳細検証と、その非対応だけで全 Session を拒否する扱いを削る。それ以外の安全性・header / 基本 entry / 専用 CustomEntry 検証は緩和しない。

W2/W3 は本文・Tool 結果・Usage 等を実際に証拠として使う field だけを公開契約に沿って検証する。非対応部分は取得不足として表示し、他の有効な明示関連付けを失わせず、推測で補わない。header / link / Artifact identity 等の不正や未知 version は採用しない。未知の任意 field を file permission や所属根拠へ昇格させない。

Root の subagent / bg_wait / 公開 completion details にある runId / asyncId / child result の明示参照から直接子だけを取得する。workflow child の run ID と wrapper の run ID、子 Session ID、file path を区別する。公開 status / metadata / transcript / child Session / output archive / process-terminal proof を取得可能な範囲で読む。

許可 root は現在の Session directory（Root file stem 配下の参照子 Session・subagent-artifacts を含む）、現在 cwd の固定 `.pi/subagents/` 領域、および公開 layout と現在の environment から確定した user-scoped temp 領域だけ。temp scope を確定できない、過去の override と一致を確認できない、独自 root の場合は取得しない。任意 toolResult path を許可 root に追加しない。許可 root 内でも、対応する Artifact 種別・run identity・schema を検証する。

子の本文は metadata.parentSessionId と Root ID、または child header.parentSession と検証済み Root file path で直接親を確認してから採用する。両方存在して矛盾すれば採用しない。双方欠損なら親未確認候補として参照だけを表示する。fork 子の継承 prefix は entry ID 等で親由来と確認できる範囲を除外し、子に帰属する範囲を確定できない場合は本文の通常集計をせず公開結果と制限を表示する。nested / 任意 output override は対象外とする。

read は regular file / path / symlink / containment / header / schema を検証し、open 後の fstat 等でも検証する。read 開始時の byte 境界までを対象にし、追記後の内容は次回集計へ送る。ファイルの非通常な変更・短縮・不正行・未完末尾・省略を明示する。

### 5. 観測データと再集計

schemaVersion 1 の同じデータ object から JSON と HTML を生成する。最小項目は taskflowId / displayName / collectedAt / effectiveLimits、Planning と Issue refs、Root / child の識別、provenance 付き observations、現在の source availability、conflicts / quarantine / 取得範囲の制限、contentDigest。

provenance は source 種別、Session ID / entry ID / block 位置、または既存 run ID / asyncId / Artifact 種別 / field 位置、参照 path、取得時点を持つ。path は読み取り許可でも ID でもない。Session entry は出典キー＋値で dedup。同じ immutable entry の異なる値は両方保持して conflict。可変 status 等の異なる値は観測値の変化として保持し、それだけで矛盾・成功・終了を推測しない。新たな評価・世代 ID は作らない。

旧 JSON は最初に上限付きで読み、schema / taskflowId を検証する。不正・未知形式・上限超過は空データにせず更新停止。保存済み observations と新規 observations の集合を merge し、現在の取得状態を更新する。消失・短縮・読取失敗・scan 打切りだけで旧観測を削除しない。現在の取得不足は再取得成功で解消できる。所属は保存済みと今回の有効な明示関連付け証拠だけから同じ対応表で計算する。不明状態・過去 unresolved グループを保存・復元・再解決する処理を追加しない。明示証拠の矛盾は保持して表示し、一意所属にしない。

記録するものは user の依頼、assistant の text 報告、Tool / command と結果、子依頼・結果・Review、取得できた承認結果、追加依頼・修正・停止の文章、時刻と Usage の出典付き値。system prompt / thinking / signatures / image base64 は保存しない。Issue / Plan を後から network 取得せず、実行ログ中の取得内容と報告だけを当時の証拠として扱う。

Root の最後の assistant text は「取得範囲内の最新報告」と表示し、実行終了とは認定しない。READY_FOR_MERGE / BLOCKED / REPLAN_REQUIRED / FAILED は報告中の明示的な独立 marker を報告値として引用できるが、Evaluation 判定にはしない。Review は明示 Agent / Tool と依頼・結果を辿れる形で表示し、指摘解決を意味判断しない。終了コード等は対応する構造化値がある場合だけ出典付きで表示する。一般 Tool の isError=false や「テスト成功」の文章を終了コードに置換しない。

Usage は Root assistant / Tool nested / compaction / usage entry / 子等の出典と範囲を分け、欠損を0にしない。重複する可能性のある Root Tool usage と子 usage を全体合計として加算しない。

branch_summary、複数 children / roots、entry 重複・親連鎖異常、append 順の parent 飛び、現在 Session の leaf と末尾の不一致、派生 Root header を検出した場合は、識別と理由まで表示し通常の成果・Review・承認集計から外す。保存済みの分岐検出も保持し、後のログ短縮で通常表示へ戻さない。compaction / context_edit は raw 記録と要約・context 編集として区別し、それだけで tree 分岐とはしない。未記録 navigation の完全検出不能を常に限界として示す。

Planning の登録 Issue に実行が見つからなければ「実行記録が見つからない」と表示し未実施と断定しない。未登録・所属不明・矛盾は今回読み取れた記録の不足として一覧・レポートに示すが、独自の unresolved 登録や解決待ち状態にはしない。不明な候補を先頭選択・推測で通常実行に採用したり、複数 Taskflow に重複採用したりしない。

### 6. 手動操作と HTML

Pi command `/taskflow-evaluate` を登録し、`await ctx.waitForIdle()` 後に集計する。UI で未指定なら displayName / Issue / Planning 日時を示して Taskflow を選択する。取消は保存しない。

非 UI では `/taskflow-evaluate --list` で候補を取得し、`/taskflow-evaluate <Issue URL または project-relative ticket path>` で一意の Taskflow を指定できる。任意の補助指定として `--taskflow <id>` も受け付ける。無指定・複数候補・探索未完了は候補と理由を返し保存しない。番号だけでは指定しない。内部 ID の暗記・手入力は必須にしない。

command はモデル turn / sendUserMessage / 新しいモデル呼出し・会話メッセージの追加を行わない。TUI / RPC では対応 UI 通知、UI のない CLI print / JSON mode の `/taskflow-evaluate --list` は一行の `TASKFLOW_EVALUATION_RESULT ` prefix 付き JSON receipt と末尾 LF を stdout（fd 1）へ出す。集計時の CLI receipt も同じ出力契約を維持する。Pi の stdout redirect を避け、Node 標準機能で書込完了を待ち、同期 throw・callback error・stream error を呼出元へ伝播させる。書込失敗を成功扱いせず、失敗した一行を別出力で成功に見せない。receipt は候補または保存結果、対象、file path、digest、warnings / error code、JSON committed / HTML updated、再開条件を持つ。CLI exit code や RPC prompt handled だけを完全出力・集計成功の証拠にしない。

具体的な `createWriteStream` の使用は固定しない。今回確認した最小方針は、既存の fd 1 に接続された stdout を receiver として公開 `Writable.prototype.write.call(process.stdout, receiptLine, callback)` を呼び、Pi が差し替えた instance `write` を通さない方法とする。stdout object / prototype の書換え、private field / method の利用、新しい fd owner・種別別の出力基盤は不要。一行を一回 write し、その callback を await する。戻り値 false の場合も追加 chunk を投入せず、処理を Node 標準の pipe / backpressure に委ねる。書込開始前から error event も扱い、callback error の後続 event を未処理にせず、既存 listener を消さず、自分の listener は適切に解除する。stdout を end / destroy / close せず、開いた stdout 全体の `finished()` を待たない。独自 retry / queue・新規 dependency・第三者 patch は追加しない。

根拠は Node v24.21.0 の [writable.write（callback・error・backpressure）](https://nodejs.org/download/release/v24.21.0/docs/api/stream.html#writablewritechunk-encoding-callback)、[process.stdout（fd 1 と型）](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processstdout)、[Writable の公開ソース](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/streams/writable.js)、Pi 1.1.0 の導入済み `dist/core/output-guard.js` の instance `write` 差替え、および前述の Probe。公開ソースの確認は private API の使用許可ではない。書込 callback はその chunk の処理完了境界で、受信側の読了 ACK や永続化保証ではない。Implementation では変更後の公開 command / 実 CLI で再検証する。

HTML は外部 CDN・network・script が不要な自己完結の静的ページとし、Taskflow → Planning / Issue → Root / 子 → 証拠を見出し・内部 anchor・details で辿れるようにする。報告文 / Tool 記録 / 欠損・制限を別表示する。keyboard と見出し構造を維持する。ログ由来の全 text / attribute を escape し、raw HTML / JavaScript を実行しない。外部リンクは検証済み https の Issue URL だけとし、任意 local path や未知 scheme はテキスト参照にする。

集計時点・出典・取得限界・digest と「最新 JSON との一致はこの HTML 単体では未確認」を表示する。自動更新しない。

### 7. 保存・秘匿化・復旧

report directory はユーザー専用0700、file / temp / lock は0600。親 directory、既存 file、symlink / nonregular / traversal を検証する。Git repository では保存領域が ignored かつ既存 tracked file がないことを公開 git 操作で確認し、問題があれば保存停止する。非 Git directory は VCS がないことを示す。ignore / index / credentials を自動変更しない。

既知の Authorization / Bearer、token / API key / password の値、既知 token pattern、URL credential、private key block 等を秘匿化する。自由文の既知 pattern と構造化 key を対象に、merge 済みデータ全体を処理する。既知秘密を除去できれば保存を継続し秘匿化ありと示す。秘匿化失敗時は保存しない。未知秘密の完全除去は保証しない。

Taskflow ごとに排他的 lock を wx 作成し、同一出力への concurrent 更新は後発を busy で停止する。既存 lock は stale と推測して自動削除しない。自分が作成した lock だけ通常終了時に除去する。

lock 内で旧 JSON を読み、merge / 検証 / 秘匿化 / 出力上限検査を完了する。同じ directory に temp JSON / HTML を排他的生成し、両方生成成功までは旧成果物を変更しない。定めた JSON serialization の共通データ（digest field 自体を除く）から SHA-256 contentDigest を作り、JSON / HTML / receipt に同じ値を含める。JSON を rename して commit、続いて HTML を rename する。JSON commit 後の HTML 失敗は rollback せず、JSON 更新済み / HTML stale または unavailable を通知する。次回は有効な正本 JSON を保持して再生成する。command は既存ペアの digest mismatch を検出して警告する。rename だけによる電源断耐性は保証しない。

失敗処理で既存レポートを削除しない。成功・部分成功・未更新と今回分の反映状態を通知する。復旧方法は README / Skill とエラー通知に記載する。

- 上限超過：該当設定を変更し `/reload` 後に再集計。レポート削除を容量問題の解決策とは案内しない。
- JSON 破損：集計停止を確認し正常な backup を戻す、または対象 directory を別のユーザー専用・Git 除外済み場所へ手動退避して再生成する。消失済み原ログの証拠は再生成できないことを事前に通知する。
- Git tracked / ignore 不足：ユーザーが ignore を修正し対象 file を `git rm --cached` で index から外して確認後に再実行。過去 commit / push の秘密は別途失効・履歴対応が必要。
- lock 残留：集計が動いていないことを確認して、自動ではなく手動で lock を除去して再実行する。
- path / permission / 設定不正 / 秘匿化失敗：理由と該当箇所を直して再実行。安全性検証を無効化する fallback は提供しない。

## 完了条件

1. 明示的な既存対応がある再計画は同じ Taskflow を再利用し、通知を原 Session に保存・再発見できる。不明・複数所属・異所属・探索未完了では関連付け記録・独自 pending 状態・回避 UUID を追加しない。過去の正規 unresolved と別 Issue の不明状態は、別の明示対応を妨げない。重複・切替・fork コピー・不正 header / 専用 entry を誤採用しない。
2. Planning 自体や Issue #2 で未集計でも、後の command で取得可能な関連記録を含められる。同一 Session は更新、同一 Issue の別 Session は別実行になる。
3. Root と直接子の依頼・結果・Review を公開の対応証拠から辿れ、ID 種別・親未確認・fork 由来範囲・nested・消失・非対応形式・省略を明示する。
4. 停止・失敗・途中・未登録・欠損を成功・未実施・使用量0に置換しない。報告・観測・未知を区別し、検出した tree の別枝を混ぜない。
5. 旧証拠を保持しつつ再集計でき、後日の矛盾・tree 検出で表示を見直せる。JSON / HTML は同じデータと digest を使う。HTML の script / scheme 注入が実行されない。
6. 部分 settings 上書き、global / trusted project 優先順位、無指定 defaults、/reload、不正値・未知項目、設定を下げた既存 JSON の読取失敗、上限引上げ後の再実行が動作する。
7. path / symlink / schema / Git 除外 / 権限 / 秘匿化 / 容量 / concurrent 更新を検証する。生成前失敗・overflow で旧ペアが不変。JSON commit 後の HTML 失敗は正確に部分成功となり、次回修復できる。
8. 集計による新しいモデル呼出し・原ログの変更・Issue / Plan / コードの変更がない。Evaluation なし・通知失敗でも Taskflow の承認と進行が維持される。
9. 未保存 leaf では Evaluation の追加を行わず、append 前後の保存確認を維持する。非対応の会話内容だけでは有効な関連付けを失わない。W1 の負荷条件は100 Planning Sessions + 100 Implementation Sessions（合計200 Sessions）、Issue refs は全体で100件とする。各 Planning に100件ではない。この条件で所属結果と CLI text / JSON receipt の完全出力・書込完了待ち・失敗伝播を確認し、所属 index の反復構築による遅延延を避ける。通常・境界・異常ケースは別に維持し、settings defaults は変えない。正式 checks と直接検証を通し、基本設計の関係箇所・README・一つの Evaluation Skill を改訂契約と整合させる。縮小負荷の成功を旧規模の保証や切断問題の修正完了に置換しない。

## 動作確認方法

既存 `tdd` Skill を使い、合意済みの二つの seam（登録 Tool の呼出し／登録 command の実行）で一つの失敗テストから縦に実装する。内部 helper の呼出し順や private method を検証せず、実 file の一時 fixture と公開 Pi SDK を優先する。Pi runtime / UI / model / 故障注入は外部境界だけで stub し、独自 test infrastructure を作らない。

後の Implementation は `src/contracts.ts` / `src/discovery.ts` / `src/index.ts` と `tests/taskflow-evaluation.test.ts` の既存部分差分を再確認し、以下の簡略化契約を満たすことを改めて検証する。通常再利用、異所属・複数所属、保存安全性、receipt の通常・境界・異常ケースは維持する。CLI 負荷 fixture のみ下記の件数へ縮小し、出力方式を変更した場合は既存 `createWriteStream` spy を選択した公開書込境界へ合わせる。内部 method の呼出順・回数を固定するテストへ置換しない。

- 関連付け：新規 Planning → Issue refs → 別 Session Implementation → 後の集計。中間 Issue 未集計、再実装、同一所属の再計画、重複・union・切替拒否・fork コピーを維持する。不明な sourceIssues、全件のうち一件不足、複数 UUID、異なる UUID、探索未完了では通知結果が非保存で、memory / 原ファイルに新 entry・pending・新 UUID を追加しないことを確認する。初回非保存後に明示対応が得られた通常の通知は既存 ID を再利用できるが、自動再試行はしない。
- 過去記録：正規の旧 unresolved begin の sourceIssues=[A,B] と add_issues=[C]、別 Session の明示 A→T を fixture にし、A は T を再利用、B/C は再利用不可、旧 Session / B/C は T の候補へ混入しないことを Tool / command で確認する。旧 Session の begin 再通知 / add_issues は append なし・原ログ不変・新 UUID なし、phase 切替は拒否。旧形の sourceIssues 欠落・taskflowId 両立・未知 version は拒否する。
- 保存確認：in-memory / 原ファイル未作成、memory-only CustomEntry と通常 message の未保存 leaf は append 前停止。append 失敗・保存後 throw・partial append の冪等性を原ファイルと公開入口の結果で確認する。queue / flush / 修復は行わない。
- Discovery：cwd 不一致、directory 衝突、不正 header / 基本 ID・parent / 専用 link / origin、未知 version、巨大 file / 行、未完末尾、読取総量・候補数上限を検証する。未読候補に矛盾があり得る場合は reuse しない。既存の会話 role / content / Usage 詳細だけで拒否するテストを、有効な関連付けの一覧・再利用が成立する期待へ変更し、原ログ不変を確認する。不正な識別構造まで通す期待にはしない。
- 子証拠：0.77.0 の foreground / background / workflow の公開 result / status / metadata / archive fixture、UUID と path の照合、親欠損・矛盾、fork prefix、期限切れ、任意 path・nested 非対応。少なくとも直接子 foreground と background は実 Pi で取得可能な実ログ形式も確認する。未確認の形式を対応済みと報告しない。
- 再集計：旧ログ消失・短縮でも証拠保持、同一 entry dedup / 改変 conflict、status running → completed、後から tree 検出して旧観測も通常表示から除外、Usage の範囲表示、取得不足の解消を確認する。
- 安全保存：出力上限超過・壊れた旧 JSON・未知 version・symlink / traversal / nonregular・tracked 保存先・権限不足・秘匿化・同一出力 concurrent lock・temp 生成失敗で旧成果物が失われないこと。JSON commit 後の HTML rename 失敗、mismatch 通知、次回修復を確認する。
- Settings：defaults、JSON 上限だけの指定、global / trusted project の項目別 merge、trust で読み込まれない project、/reload、不正値・未知項目、byte 換算 overflow、引上げ後再集計を検証する。effective settings 全体や秘密が出力されないことも確認する。
- W1 負荷 / CLI 実動作：公開 loader / SDK の登録 Tool 実行と command prompt を確認する。負荷 fixture は100 Planning Sessions + 100 Implementation Sessions、全体で100 Issue refsとし、最小構成は各 Planning に一つの異なる Issue と対応する一つの Implementation を割り当てる。実 Pi CLI text / JSON の --list をそれぞれ少なくとも3回反復し、100 Planning・100 Implementation の識別、候補・Issue の期待集合、所属結果、欠落・重複なし、原ログ不変、処理時間を観測する。settings defaults と通常・境界・異常ケースの fixture はこの件数へ連動変更しない。所属 index の内部呼出回数・順序を固定せず、反復全探索へ戻っていないことをコード確認と公開入口で検証する。
- CLI 出力境界：成功時は prefix 付き receipt がちょうど一行あり、末尾 LF・完全な JSON parse・期待する候補集合を満たし、receipt / command error が stderr に出ないことを確認する。JSON mode の独立した Session header 行は区別し、receipt の途中混入や切断を許容しない。受信 byte 数を観測し、合成出力では期待 byte 数・hash とも照合する。遅い pipe reader で backpressure と完了待ち、file への redirect と stdout 再利用を確認する。公開 command handler の書込境界に callback error / stream error / 同期 throw を注入して reject が呼出元へ届き、成功 completion を返さないこと、自分の listener を残さず既存 listener を消さないことを検証する。閉 pipe の実 CLI は失敗経路として stderr・receipt 完全性・exit を別々に観測し、Pi 自身の終了処理による失敗と command の失敗伝播を区別する。CLI exit 0だけで成功にしない。
- 旧規模の扱い：2000 Sessions / 100000 Issue refs の負荷 fixture 維持と、その成功による完了判定は要求しない。約18 MBの EAGAIN / ERR_SYSTEM_ERROR による切断は既知の未完了観測として残す。出力方式の合成 Probe が成功しても、縮小 fixture が成功しても、旧規模の候補一覧を修正済み・検証済み・保証済みとは報告しない。
- W2/W3 の実動作：TUI 選択・取消、非 UI Issue 指定 / 曖昧指定、HTML のローカル閲覧・keyboard・内部遷移・注入 payload、JSON / HTML digest、保存 mode、モデル request 0回を確認する。モデルを throw / count する SDK 境界で command の無モデル性を確認し、実子検証に伴うモデル使用とは区別する。
- 元の Session / Artifact / Issue / Plan / コードは、関連付け時の許可された CustomEntry 追加以外に変化がないことを確認する。未導入・通知失敗の Taskflow 手順も検証する。

各 Implementation で `pnpm check` と Work Item の直接検証を Root が実行する。未解決の失敗を完了扱いにしない。隣接 Taskflow 変更は当時の正式 checks を再確認して実行し、通知接点・通知不能時の継続・既存の個別承認手順の維持を直接確認する。

## リスクと引継ぎ

上限を引き上げるとメモリ・処理時間・保存容量が増える。設定値は finite でも全量を一括確保せず bounded / streaming に読む。未知秘密、scope 外の所属矛盾、未記録 tree 移動、期限切れ Artifact、旧 HTML 単体の stale 判別不能、電源断は残余リスクとして表示する。

前回の Oracle 助言は、旧 unresolved の厳密な識別と新規書込の分離、旧 add_issues の所属昇格禁止、旧 Session への再保存・phase 切替防止だけを採用した。今回も新しい解決・補正・互換基盤は追加しない。助言や出力 Probe はユーザー承認の代わりではない。

今回の負荷条件縮小と具体的な stream API 固定解除は、ユーザーが希望した限定改訂である。探索上限 defaults の縮小、CLI 出力制限や省略、旧規模不具合の修正保証には広げない。部分実装は未完了であり、変更後の Root checks / 直接検証・独立2 Review・`taskflow_code_review` gate が揃うまで W1 完了としない。基本設計・README・Evaluation Skill の既存の未整合箇所と旧規模を検証済みと読める説明は W1 Implementation で関係箇所だけ更新する。今回の Planning ではこれらのファイルを編集しない。

### 既存 Work Items と文書への反映

正式な Issue 一覧・本文と raw body から以下を確認した。いずれも調査時 OPEN。依存とスライスは維持し、重複 Issue を作らない。

- W1: https://github.com/minorunakamura/pi-taskflow-evaluation/issues/1 — 関連付け通知と候補発見。未コミット W1 の contracts / discovery / index と対応テストを簡略化し、README / Evaluation Skill、基本設計の識別・再計画・新規実装前提の関係箇所を更新する。基本設計全体は書き直さない。Issue #1 の旧 Plan 全文・hash・承認参照を改訂全文と一致させる。
- W2: https://github.com/minorunakamura/pi-taskflow-evaluation/issues/2 — Root レポートと保存済み JSON 統合。保存済みの明示対応による所属計算・証拠保持と unresolved 状態管理を区別し、本文の利用 field 検証・非対応部分の不足表示を明記する。W1 に依存。
- W3: https://github.com/minorunakamura/pi-taskflow-evaluation/issues/3 — 直接子の公開証拠取得。親・Artifact identity / schema / 安全性を維持し、証拠に使う本文 field の検証と不足表示だけを行う。Root の所属を unresolved 復元で補わない。W2 に依存。
- W4: https://github.com/minorunakamura/pi-taskflow/issues/22 — 隣接 `pi-taskflow` の3 Skills。簡略化した optional 通知・関連付け不能時の継続を反映し、保存待ち・再解決手順を追加しない。W2 に依存、W3 を blocker にしない。対象 cwd は `/Users/minoru/Documents/mywork/pi-dev/pi-taskflow`。

承認後の正式保存先は `docs/plans/taskflow-evaluation.md`。全文を承認どおり保存してから taskflow-to-ticket へ渡す。各 Work Item は正式パスと閲覧可能な #1 の同一全文を参照する。今回の Planning は既存分割・依存を維持する確認と、最終本文・保存先の保存公開承認を Plan 承認から分離する。Issue #1 の完了条件・検証方法・埋め込み Plan 全文・SHA-256・今回の承認参照を整合させる。W2 / W3 / W4 は Plan hash・承認参照など参照整合に必要な更新だけを行い、機能範囲・分割・依存を変えない。重複 Issue・追加 Work Item は作らない。tracker 設定は ticket Skill だけが読み取り・再利用し、必要な変更にも別の承認を得る。各 Implementation は一回の新しい Session で実装・検証する。Work Items の更新・公開後は停止し、Worker 起動・実装・commit・merge・release・deploy を開始しない。
