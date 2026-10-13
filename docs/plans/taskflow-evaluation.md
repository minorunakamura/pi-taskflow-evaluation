# Taskflow の関連付け・事後集計・ローカルレポートの新規実装

## 目的

`docs/designs/taskflow-evaluation.md` を入力として、Planning と複数 Issue の Implementation を一つの Taskflow として振り返れる optional Pi Extension / Skill package を新規実装する。既存ログから依頼・実施・報告・検証・Review・停止理由とその出典を整理し、報告されたこと、直接記録されたこと、取得できないことを区別する。

Evaluation は正しさ・品質・工程の十分性を判定しない。LLM Judge、新しいモデル呼び出し、承認の代行、Taskflow 完了の認定は行わない。

## 要件・決定事項

- Planning と各 Implementation は別の新しい Root Session。一つの Root Session は一回の実行を扱う。実行キーは Root Session ID。同じ Issue の別 Session は別実行、同じ Session の再集計は更新とする。
- Issue は GitHub の hostname / owner / repository / issue number、または対象 cwd 内の正規化した local ticket path で識別する。番号だけ・タイトル・時刻・会話の意味から所属を確定しない。
- 再計画は、入力の既存 Issue の所属がすべて一意かつ同じ Taskflow の場合だけ同じ Taskflow に追加する。所属なし・矛盾・複数候補・探索未完了は unresolved。別 Taskflow を自動発行して回避しない。
- 自動発見は現在の cwd と現在の Session directory に限定する。header.cwd も照合する。別 worktree、別 Session directory、過去の異なる temp root は横断しない。
- `../pi-taskflow` の Planning / ticket / Implementation Skill への最小の optional 通知追記も実装範囲とする。未導入・非アクティブ・通知失敗は入力・進行・承認条件を変えず、独自の代替記録を作らない。
- 関連付け Tool と手動集計 command の二つの公開 seam で TDD を使う。
- レポートは `.pi/taskflow-reports/<taskflowId>/report.json` と `report.html`。JSON を正本、HTML を同じデータから生成する派生成果物とする。独立した評価 ID・評価履歴は作らない。
- 保存済みの証拠は原ログの消失だけで削除しない。現在の取得状態・所属・通常表示の可否は保存済みと今回取得した証拠から再計算する。
- 固定2ファイルの同時 atomic 更新は保証しない。JSON commit 後の HTML 更新失敗は部分成功として通知し、次回再集計で修復する。
- 上限は `settings.json` の `taskflow-evaluation.limits` で項目単位に変更できる。無指定では本 Plan のデフォルトを使う。

## 制約・対象外

- 実行中 collector、queue、workflow state、収集の停止・再開、独自 Agent / tracker / 子実行管理は追加しない。
- Pi / pi-subagents の実行・ログ保存、原ログ、Issue / Plan / 対象コードを集計で変更・削除しない。関連付け CustomEntry の追加だけを行う。
- 旧 Evaluation 保存形式の互換・移行、過去の未登録会話の自動関連付け、所属補正と補正履歴、Plan 全文の専用保存・hash 照合・版管理、Git snapshot、厳密な Timeline、品質スコア、完全な Usage 合計は対象外。
- 会話 tree の巻き戻し・分岐を含む実行の通常集計、完全な nested 実行階層、任意 output override のファイル取得は対象外。検出した制限を表示する。
- 秘密専用ファイル・認証設定の追加読取、外部送信・公開・ブラウザ自動起動、削除機能・保存期限管理は提供しない。
- 新規 dependency、独自設定ファイル、設定を変更する Tool、追加の Draft 管理・manifest・世代 directory は作らない。既存 TypeScript / TypeBox / Vitest / Node 標準機能を使う。
- 今回の Planning は Approved Plan と確認済み Work Items の保存・公開で終了する。production code の実装、Worker 起動、merge / release / deploy は別セッションの別許可による。

## 確認した事実と限界

対象 checkout は `pi-taskflow-evaluation` の `e1d6b00`、隣接 `pi-taskflow` は `0a7469d`。両者の調査時の worktree は clean。Evaluation の src / tests / skills は空で、旧実装の削除は不要。package は src/index.ts と skills を Pi resource として宣言済み。正式なチェックは `pnpm check`、CI は Node 24.21.0 と pnpm を使う。

- Pi 1.1.0 の公開 `ExtensionAPI.appendEntry()` は非会話の CustomEntry を追加する。公開 context から cwd / Session ID / Session file / Session directory / leaf を取得できる。
- 新規 Session は CustomEntry だけではファイル化されず、最初の user / assistant message で保留 entry を flush する。getSessionFile の値だけでは保存成功を証明しない。in-memory Session は永続化されない。
- `SessionManager.open()` は migration・末尾改行補修等で原ファイルを書き換え得る。`list()` は本文全体を読むため、集計 reader には使わない。公開 JSONL 形式を上限付きで直接読み取る。
- fork は CustomEntry もコピーする。登録元 Session ID と現在の header.id の照合が必要。
- summary なし tree 移動は entry 追加がなければ原ログに記録されない。後から完全な操作履歴・終了時 leaf を復元することはできない。
- pi-subagents 0.77.0 の公開ログ契約では metadata.parentSessionId は親 Session ID、child header.parentSession は親 Session file path。status の sessionId を子 UUID と推測しない。公開 lifecycle version は3、replay / output archive は version 1。一時 Artifact は cleanup / 通知消費等で消失し得る。
- Pi の公開 `pi.getSettings()` は trust / global / project / overrides を反映した effective settings を返す。設定 object は項目単位に deep merge される。設定ファイルの独自読み直しは不要。

根拠はインストール済 Pi 1.1.0 の README / docs/extensions.md / session-format.md / message-types.md / sdk.md / settings.md / configuration.md と開発依存の公開型・関連実装、pi-subagents 0.77.0 の docs/observability.md / extension-api.md / 公開型、隣接 Taskflow Skills / extensions/taskflow.ts / src/settings.ts。

一時 directory の公開 SessionManager による assert Probe で、user message による CustomEntry 永続化（assistant 未追加）、entry 無追加 navigation のファイル不変、append 後の複数 children、fork での登録コピーを確認した。初回の instance method / static method の呼び違いを公開型で修正し、再実行は成功。原ログ・本番コード・モデル・ネットワークは使用せず、一時ファイルは削除済み。新 Extension の一貫動作、実子ログ形式、安全な filesystem 更新はまだ未検証であり、下記の完了条件で確認する。

## 実装方針

### 1. 関連付け契約

`src/index.ts` の Extension に direct Tool `taskflow_evaluation_link` を登録する。以下の3操作を schema で区別し、Root が呼ぶ。Taskflow ID をユーザーに覚えさせない。

| operation | 入力 | 動作 |
|---|---|---|
| begin_planning | displayName、必要な場合だけ sourceIssues | 新規なら UUID を発行。再計画なら取得済み既存 Issue の所属を解決して再利用。未確定なら unresolved を記録 |
| add_issues | 作成・取得確認済みの Issue refs | 同じ Planning 実行へ対応を追加。部分作成なら確認できた項目だけ通知。未作成 Issue を推測しない |
| implementation | 取得確認済みの対象 Issue ref | Implementation と対象を登録。Taskflow ID は受け取らず、集計時に Planning の対応から解決 |

CustomEntry の customType は `pi-taskflow-evaluation.link`。version 1 の最小 payload は originSessionId、phase、operation に必要な taskflowId / displayName / issues / sourceIssues / unresolved reason。cwd と Root ID は context / header から取得し、originSessionId だけは fork のコピー排除のため payload に保存する。Plan 本文・進行状態・保存待ち情報は入れない。displayName は最大160文字、Issue refs は1回最大100件、entry は最大64 KiBとする。これらは小さな通知契約の固定入力制限で、レポート上限設定とは別。

同じ origin の同じ通知は冪等。Planning の Issue 追加は集合の union とし削除しない。同じ Session の別 phase / 別 Implementation Issue / 異なる Taskflow への切替は拒否し、正常な別実行を作らない。origin が header と異なるコピー entry は所属証拠に採用しない。矛盾は削除・上書きで消さず表示する。

GitHub は https の Issue URL または明示構造から host / owner / repository / 正の issue number を検証する。host は小文字、owner / repository は GitHub の識別規則に沿って照合する。local は現在 cwd 内の project-relative ticket path で識別し、traversal / symlink escape を拒否する。Issue / ticket 本文はこの Tool では再取得しない。

Tool は通知前に入力・既存登録・永続化可能な Session を検証し、appendEntry 後の原ファイルで対応 entry を確認して保存済みと報告する。書込失敗後に memory に entry が見えることだけを成功としない。非永続・未登録・保存未確認は明示した結果にする。partial append の再試行も原ファイルの有効 entry を照合し、二重登録しない。

再計画の所属解決は後述の限定探索と保存済みの有効な関連付け証拠を使う。必要な探索が未完了なら reuse しない。「一意」は現在の限定 scope 内での意味であり、scope 外の矛盾不存在は保証しない。

### 2. Taskflow Skill の通知接点

隣接 repository の以下だけに通知手順を追記する。第三者の導入済み Skill、global 設定、Extension 配線は変更しない。

- taskflow-planning：目的と新規 / 再計画対象が確認できた時点で begin_planning。再計画 sourceIssues は通常取得して確認した参照を使う。Approved Plan と正式パスを ticket Skill に渡す際に、利用可能な通知の契約を渡す。
- taskflow-to-ticket：ユーザーの保存・公開承認後、各 Issue / local ticket の作成・取得確認後に add_issues。既存同一チケットの再利用と部分作成にも確認済み refs を通知する。未承認・下書き・未確認の番号を登録しない。
- taskflow-implementation：対象 Work Item の取得先・識別が確認できた時点で implementation。Worker 起動前に行い、その後 BLOCKED / REPLAN_REQUIRED になった実行も識別可能にする。

各 Skill は通知 Tool がモデルに提示され利用可能な場合だけ呼ぶ。不可・失敗・呼び忘れで Taskflow を停止したり、承認を変更したり、代替 Tool / manifest を作らない。登録前に停止した実行は欠損として扱う。Plan / tracker 設定 / 分割 / 保存公開の個別承認手順は維持する。

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

候補数・容量の読取上限は取得不足として明示する。関連付け探索の未完了・解釈不能は一意所属の確定を妨げる。構造を検証できないログを通常実行として説明しない。EOF の未完行は確定 entry とせず次回再読する。出力・Root 数・証拠件数の merge 後上限超過は更新全体を停止し、既存 JSON / HTML を保持する。新規分の選別保存や旧証拠の間引きはしない。エラーには超過項目・設定値・変更キー・未反映範囲・再開条件を示す。

### 4. 発見と read-only 集計

現在の Session directory の top-level JSONL 候補と `.pi/taskflow-reports/` の検証済み保存結果だけを bounded に列挙・読取する。無関係な project directory や子 Artifact を全探索しない。header.cwd、Session ID、CustomEntry schema / origin を検証して候補を作る。Session ID は Pi が custom ID も許すため UUID 固定検証にしない。出力 directory の Taskflow ID は Extension が発行した UUID のみ許す。

Pi Session format v3 と pi-subagents 0.77.0 の文書化された公開 file / result 契約を初版の対応範囲とする。runtime private import / registry / 他 Session の RPC status を使わない。未知 version / schema は採用せず不足として表示する。未知の任意 field を file permission や所属根拠へ昇格させない。

Root の subagent / bg_wait / 公開 completion details にある runId / asyncId / child result の明示参照から直接子だけを取得する。workflow child の run ID と wrapper の run ID、子 Session ID、file path を区別する。公開 status / metadata / transcript / child Session / output archive / process-terminal proof を取得可能な範囲で読む。

許可 root は現在の Session directory（Root file stem 配下の参照子 Session・subagent-artifacts を含む）、現在 cwd の固定 `.pi/subagents/` 領域、および公開 layout と現在の environment から確定した user-scoped temp 領域だけ。temp scope を確定できない、過去の override と一致を確認できない、独自 root の場合は取得しない。任意 toolResult path を許可 root に追加しない。許可 root 内でも、対応する Artifact 種別・run identity・schema を検証する。

子の本文は metadata.parentSessionId と Root ID、または child header.parentSession と検証済み Root file path で直接親を確認してから採用する。両方存在して矛盾すれば採用しない。双方欠損なら親未確認候補として参照だけを表示する。fork 子の継承 prefix は entry ID 等で親由来と確認できる範囲を除外し、子に帰属する範囲を確定できない場合は本文の通常集計をせず公開結果と制限を表示する。nested / 任意 output override は対象外とする。

read は regular file / path / symlink / containment / header / schema を検証し、open 後の fstat 等でも検証する。read 開始時の byte 境界までを対象にし、追記後の内容は次回集計へ送る。ファイルの非通常な変更・短縮・不正行・未完末尾・省略を明示する。

### 5. 観測データと再集計

schemaVersion 1 の同じデータ object から JSON と HTML を生成する。最小項目は taskflowId / displayName / collectedAt / effectiveLimits、Planning と Issue refs、Root / child の識別、provenance 付き observations、現在の source availability、conflicts / quarantine / 取得範囲の制限、contentDigest。

provenance は source 種別、Session ID / entry ID / block 位置、または既存 run ID / asyncId / Artifact 種別 / field 位置、参照 path、取得時点を持つ。path は読み取り許可でも ID でもない。Session entry は出典キー＋値で dedup。同じ immutable entry の異なる値は両方保持して conflict。可変 status 等の異なる値は観測値の変化として保持し、それだけで矛盾・成功・終了を推測しない。新たな評価・世代 ID は作らない。

旧 JSON は最初に上限付きで読み、schema / taskflowId を検証する。不正・未知形式・上限超過は空データにせず更新停止。保存済み observations と新規 observations の集合を merge し、現在の取得状態を更新する。消失・短縮・読取失敗・scan 打切りだけで旧観測を削除しない。現在の取得不足は再取得成功で解消できる。所属は保存済みと今回の関連付け証拠から再解決する。

記録するものは user の依頼、assistant の text 報告、Tool / command と結果、子依頼・結果・Review、取得できた承認結果、追加依頼・修正・停止の文章、時刻と Usage の出典付き値。system prompt / thinking / signatures / image base64 は保存しない。Issue / Plan を後から network 取得せず、実行ログ中の取得内容と報告だけを当時の証拠として扱う。

Root の最後の assistant text は「取得範囲内の最新報告」と表示し、実行終了とは認定しない。READY_FOR_MERGE / BLOCKED / REPLAN_REQUIRED / FAILED は報告中の明示的な独立 marker を報告値として引用できるが、Evaluation 判定にはしない。Review は明示 Agent / Tool と依頼・結果を辿れる形で表示し、指摘解決を意味判断しない。終了コード等は対応する構造化値がある場合だけ出典付きで表示する。一般 Tool の isError=false や「テスト成功」の文章を終了コードに置換しない。

Usage は Root assistant / Tool nested / compaction / usage entry / 子等の出典と範囲を分け、欠損を0にしない。重複する可能性のある Root Tool usage と子 usage を全体合計として加算しない。

branch_summary、複数 children / roots、entry 重複・親連鎖異常、append 順の parent 飛び、現在 Session の leaf と末尾の不一致、派生 Root header を検出した場合は、識別と理由まで表示し通常の成果・Review・承認集計から外す。保存済みの分岐検出も保持し、後のログ短縮で通常表示へ戻さない。compaction / context_edit は raw 記録と要約・context 編集として区別し、それだけで tree 分岐とはしない。未記録 navigation の完全検出不能を常に限界として示す。

Planning の登録 Issue に実行が見つからなければ「実行記録が見つからない」と表示し未実施と断定しない。unresolved な候補は一覧・関連するレポートの不足情報に示すが、候補 Taskflow の通常実行として重複採用しない。

### 6. 手動操作と HTML

Pi command `/taskflow-evaluate` を登録し、`await ctx.waitForIdle()` 後に集計する。UI で未指定なら displayName / Issue / Planning 日時を示して Taskflow を選択する。取消は保存しない。

非 UI では `/taskflow-evaluate --list` で候補を取得し、`/taskflow-evaluate <Issue URL または project-relative ticket path>` で一意の Taskflow を指定できる。任意の補助指定として `--taskflow <id>` も受け付ける。無指定・複数候補・探索未完了は候補と理由を返し保存しない。番号だけでは指定しない。内部 ID の暗記・手入力は必須にしない。

command はモデル turn / sendUserMessage / 新しいモデル呼出しを行わない。TUI / RPC では対応 UI 通知、print / JSON mode では一行の `TASKFLOW_EVALUATION_RESULT ` prefix 付き JSON receipt を stdout に出す。receipt は候補または保存結果、対象、file path、digest、warnings / error code、JSON committed / HTML updated、再開条件を持つ。CLI exit code や RPC prompt handled を集計成功と同一視しない。

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

1. Tool の通知を原 Session に保存・再発見できる。重複通知で実行や Taskflow が増えず、fork コピー、矛盾、再計画の不明所属を誤採用しない。
2. Planning 自体や Issue #2 で未集計でも、後の command で取得可能な関連記録を含められる。同一 Session は更新、同一 Issue の別 Session は別実行になる。
3. Root と直接子の依頼・結果・Review を公開の対応証拠から辿れ、ID 種別・親未確認・fork 由来範囲・nested・消失・非対応形式・省略を明示する。
4. 停止・失敗・途中・未登録・欠損を成功・未実施・使用量0に置換しない。報告・観測・未知を区別し、検出した tree の別枝を混ぜない。
5. 旧証拠を保持しつつ再集計でき、後日の矛盾・tree 検出で表示を見直せる。JSON / HTML は同じデータと digest を使う。HTML の script / scheme 注入が実行されない。
6. 部分 settings 上書き、global / trusted project 優先順位、無指定 defaults、/reload、不正値・未知項目、設定を下げた既存 JSON の読取失敗、上限引上げ後の再実行が動作する。
7. path / symlink / schema / Git 除外 / 権限 / 秘匿化 / 容量 / concurrent 更新を検証する。生成前失敗・overflow で旧ペアが不変。JSON commit 後の HTML 失敗は正確に部分成功となり、次回修復できる。
8. 集計による新しいモデル呼出し・原ログの変更・Issue / Plan / コードの変更がない。Evaluation なし・通知失敗でも Taskflow の承認と進行が維持される。
9. 正式な checks と直接検証を通し、package 導入・command・設定・制限・復旧・機密性の説明を README と一つの Evaluation Skill に残す。

## 動作確認方法

既存 `tdd` Skill を使い、合意済みの二つの seam（登録 Tool の呼出し／登録 command の実行）で一つの失敗テストから縦に実装する。内部 helper の呼出し順や private method を検証せず、実 file の一時 fixture と公開 Pi SDK を優先する。Pi runtime / UI / model / 故障注入は外部境界だけで stub し、独自 test infrastructure を作らない。

- 関連付け：新規 Planning → Issue refs → 別 Session Implementation → 後の集計。Issue #2 未集計、再実装、同一所属の再計画、sourceIssues の異所属・未登録、重複、切替拒否、in-memory、保存失敗、fork コピーを検証する。
- Discovery：cwd 不一致、directory 衝突、未知 schema、巨大 file / 行、未完末尾、読取総量・候補数上限。未読候補に矛盾があり得る場合、reuse が成立しないことを確認する。
- 子証拠：0.77.0 の foreground / background / workflow の公開 result / status / metadata / archive fixture、UUID と path の照合、親欠損・矛盾、fork prefix、期限切れ、任意 path・nested 非対応。少なくとも直接子 foreground と background は実 Pi で取得可能な実ログ形式も確認する。未確認の形式を対応済みと報告しない。
- 再集計：旧ログ消失・短縮でも証拠保持、同一 entry dedup / 改変 conflict、status running → completed、後から tree 検出して旧観測も通常表示から除外、Usage の範囲表示、取得不足の解消を確認する。
- 安全保存：出力上限超過・壊れた旧 JSON・未知 version・symlink / traversal / nonregular・tracked 保存先・権限不足・秘匿化・同一出力 concurrent lock・temp 生成失敗で旧成果物が失われないこと。JSON commit 後の HTML rename 失敗、mismatch 通知、次回修復を確認する。
- Settings：defaults、JSON 上限だけの指定、global / trusted project の項目別 merge、trust で読み込まれない project、/reload、不正値・未知項目、byte 換算 overflow、引上げ後再集計を検証する。effective settings 全体や秘密が出力されないことも確認する。
- UI / 実動作：TUI 選択・取消、非 UI --list / Issue 指定 / 曖昧指定、HTML のローカル閲覧・keyboard・内部遷移・注入 payload、JSON / HTML digest、保存 mode、モデル request 0回を確認する。モデルを throw / count する SDK 境界で command の無モデル性を確認し、実子検証に伴うモデル使用とは区別する。
- 元の Session / Artifact / Issue / Plan / コードは、関連付け時の許可された CustomEntry 追加以外に変化がないことを確認する。未導入・通知失敗の Taskflow 手順も検証する。

各 Implementation で `pnpm check` を Root が実行する。隣接 Taskflow 変更は当時の正式 checks を再確認して実行し、通知接点と既存の個別承認手順の維持を直接確認する。空 repository の現状では checks を実装完了の根拠として実行していない。

## リスクと引継ぎ

上限を引き上げるとメモリ・処理時間・保存容量が増える。設定値は finite でも全量を一括確保せず bounded / streaming に読む。未知秘密、scope 外の所属矛盾、未記録 tree 移動、期限切れ Artifact、旧 HTML 単体の stale 判別不能、電源断は残余リスクとして表示する。

Oracle の助言は証拠集合と現在状態の分離、探索未完了での一意確定禁止、可変 Artifact と immutable entry の区別、旧 JSON 検証、全体秘匿化、tracked 確認、overflow 時の全体停止、JSON 正本 / HTML best-effort にすべて反映した。設定による上限変更はその後のユーザー要件と確認済み公開 API に基づく追加である。助言や Probe はユーザー承認の代わりではない。

承認後の正式保存先は `docs/plans/taskflow-evaluation.md`。この全文を承認どおり保存してから taskflow-to-ticket へ渡す。各 Work Item は正式な Plan の参照を持ち、一回の新しい Implementation で demo / 検証できる縦スライスにする。隣接 Taskflow の変更は対象 repository / cwd / 編集範囲を明示する。tracker 設定・分割・最終本文と保存公開はそれぞれ必要な個別承認を得る。Work Items の保存・公開後は Implementation を開始せず終了する。
