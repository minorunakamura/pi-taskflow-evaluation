# pi-taskflow-evaluation 基本設計

- 作成日: 2026-10-13
- 用途: `taskflow-planning` に渡す、新規実装の基本仕様
- 本書は基本設計であり、Approved Plan や実装開始の許可ではない。

## 1. 目的

`pi-taskflow` の Planning と各 Issue の Implementation を、一つの Taskflow として事後に振り返れるようにする。既存の実行ログから、何を依頼し、何が実施・報告され、どの証拠が残っているかを整理する。

初版の期待する結果は次のとおり。

- Planning と複数の Implementation の関係が分かる。
- 各実行の依頼、結果、検証、Review、手戻りを確認できる。
- 報告されたこと、ログで確認できること、確認できないことを区別できる。
- 人が Taskflow の手順・Skill・Playbook の改善を考える材料を得られる。

Evaluation 独自の正しさ・十分性・品質の合否判定は行わない。テストの成功・失敗、Review の指摘、承認結果、Root の最終報告は記録として表示するが、それらから成果物の正しさや工程の十分性を保証しない。LLM Judge や新しいモデル呼び出しによる意味判断も提供しない。

## 2. 基本の使い方と責務

### 利用の流れ

1. ユーザーは従来どおり Taskflow の Planning を実行する。Evaluation が利用可能な場合は、Taskflow の識別と、Planning が作成した Issue との対応情報を Pi の Session に残す。
2. 各 Issue の Implementation は、別の新しい Root Session で実行する。開始時に、対象 Issue の識別情報をその Session に残す。
3. 振り返りたい時点で、ユーザーが Pi 上の集計コマンドを実行し、対象 Taskflow を選ぶ。
4. コマンドは、その Taskflow に関連する既存ログを読み、未集計の実行も含めて JSON と HTML を作成・更新する。

各実行の終了直後にコマンドを打つことは必須ではない。例えば Issue #2 で集計しなくても、Issue #3 の終了後の集計では、取得可能な #2 の記録も含める。Planning 自体の集計が未実施でも、関連付け情報が Session に残っていれば対象を見つけられるようにする。

成功、失敗、`BLOCKED`、`REPLAN_REQUIRED`、終了未確認の実行を対象にする。途中の集計も可能とし、最後のメッセージや Session の終了だけで Taskflow 完了を認定しない。

### 責務の境界

| 所有者 | 責務 |
| --- | --- |
| `pi-taskflow` | Planning / Implementation の手順、成果物、ユーザー判断・承認。利用可能な場合だけ関連付け情報の通知を行う |
| Pi | Root / 子 Session の既存履歴、Session ID、`CustomEntry` の保存 |
| `pi-subagents` | 子実行の実行管理、公開ログ・Artifact・結果・親子の対応情報 |
| `pi-taskflow-evaluation` | 小さな関連付け情報の登録、既存記録の読み取り、事後集計、JSON / HTML の保存 |
| ユーザー | 集計の起動、レポートを使った振り返り、改善の判断 |

Evaluation は独立した Pi Extension / Skill package とする。導入されていない場合や、関連付け・集計に失敗した場合も、Taskflow の進行・入力条件・承認条件を変更しない。独自の代替 Tool や記録機構を Taskflow 側に作らせない。

実行中の独自 collector は作らない。そのためのイベント保存 queue、記録の停止・再開制御、終了イベントの順序制御、collector の復旧も持たない。既存の Pi / `pi-subagents` の実行・ログ保存を変更しない。

## 3. 識別と関連付け

| 単位 | 識別・意味 |
| --- | --- |
| Taskflow | Planning と、そこで扱う各 Issue の Implementation をまとめる単位。対応情報に Taskflow ID を持つ |
| Issue | 実装対象。GitHub Issue は hostname / owner / repository / issue number を含めて識別する。番号だけでは識別しない |
| 実行 | 一回の Planning または一つの Issue の Implementation。Root Session ID を識別子に使う |
| 子実行 | Root に依頼された Worker / Reviewer / Scout 等。`pi-subagents` の run ID、子 Session ID、親の参照は別の識別情報として扱う |

一つの Root Session では一回の Taskflow 実行を扱う。同じ Session 内で別 Issue や別実行へ切り替える使い方は扱わない。同じ Issue を新しい Session で再実装した場合は、同じ Taskflow の別実行とする。

```text
Taskflow A
├─ Planning の実行
├─ Issue #1
│  └─ Implementation の実行
├─ Issue #2
│  └─ Implementation の実行
└─ Issue #3
   ├─ 初回 Implementation の実行
   └─ 再実装の実行
```

### CustomEntry に残す情報

関連付け情報は、Pi の `CustomEntry` に構造化して保存する。これは Session ログに残るが、LLM の会話コンテキストには参加しない。

- Planning: Taskflow の識別、Planning の実行であること、作成した Issue の参照。
- Implementation: Implementation の実行であること、確認済みの対象 Issue の参照。
- Root Session ID と作業ディレクトリは Pi の context / Session 記録から取得する。

Implementation が通常の手順で取得した Issue の参照を使い、Planning の対応情報から所属 Taskflow を解決する。ユーザーや Root Agent に Taskflow ID の記憶・別 Session への手入力を要求しない。

関連付け情報は、実行中の操作ログや workflow state ではない。Plan 全文、進行中 Tool の状態、保存待ちデータ等は持たせない。通知の具体的な Tool 名・引数・記録時点は Planning で定める。Implementation の対象情報は Worker 起動前に、Planning の Issue 対応は作成・取得確認後に残せる必要がある。

Skill による通知は Root Agent の Tool 呼び出しであり、機械的に保証されるものではない。呼び忘れや登録前の停止は欠損として扱う。Planning が登録した Issue に実行記録が見つからない場合も、その不足を表示し、未実施と断定しない。

同じ情報の重複通知で別実行を作らない。欠けた対応、矛盾した対応、複数の所属候補は不明として表示し、会話の意味、タイトル、時刻の近さから所属を確定しない。初版では、所属補正とその履歴管理は提供しない。

### Plan とドキュメント管理

所属は Issue との対応で維持し、Plan の内容 hash を Taskflow の照合条件にしない。同じ Issue の Plan が移動・改訂されても、その理由だけで所属を失わせない。

Evaluation 専用の Plan 全文保存、Plan の版管理、移動・改訂の追跡、当時の Plan との厳密な整合性判定は行わない。評価のために Issue / Plan 本文へ専用 ID を埋めたり、ドキュメントの保存・改訂ルールを変えたりしない。

Issue や参照先を後から取得した場合、その最新版を当時使った仕様として扱わない。実行中に取得・報告された内容と、後日取得した内容は区別する。

## 4. 既存ログの取得と集計

### 情報源

- Root: Pi の Session ログにある依頼、会話、Tool 呼び出し・結果、最終報告、関連付け情報。
- 子 Agent: `pi-subagents` が公開する結果、metadata、transcript、子 Session、利用可能な lifecycle Artifact。

Root の subagent 呼び出し結果や metadata にある run ID / 子の参照、`parentSessionId`、子 Session ヘッダーの `parentSession` 等で親子を結ぶ。Session UUID と Session ファイルのパスを同じ ID 種別として扱わず、公開契約に沿って照合する。

対象プロジェクトの関連付け情報から対象 Root を特定し、そこから参照できる関連子実行だけを読む。無関係なプロジェクトや子 Artifact の全探索・丸ごとコピーを行わない。Tool 結果に書かれた任意のパスを、任意ファイルの読み取り許可として扱わない。

Foreground / Background は、それぞれの公開記録から取得できる範囲を扱う。Nested を含む完全な実行階層の復元や、独自の子実行管理は要件にしない。存在しないファイル、期限切れ、非対応形式、切り詰めは明示し、欠けた内容を推測で補わない。

### 整理する内容

| 内容 | 表示・保存の考え方 |
| --- | --- |
| 依頼・対象 | Root の依頼、対象 Issue、子 Agent への依頼と識別情報 |
| 実施・結果 | 関係する Tool / command、残っている結果、子 Agent の報告、Root の最終報告 |
| 検証・Review | チェック・直接検証の記録、Review の依頼・結果、Root が報告した指摘への対応、承認 Tool の結果 |
| 手戻り・停止 | 追加依頼、修正、再計画・停止について、記録に残っている事実と理由 |
| 観測限界 | 関連付け不能、未取得、ログ消失、切り詰め、秘匿化、解釈不能な結果 |
| 時刻・Usage | 既存記録にある値を、出典と対象範囲付きで示す。正確な全体合計や不足分の補完を要求しない |

報告の文章と実際の Tool 結果は区別する。「テスト成功」という文章を終了コードとして扱わず、Tool の一般的な成功を成果物の正しさとしない。取得できた承認結果は表示するが、Evaluation が承認を代行・追加しない。

独自の開始・終了 Git snapshot は収集しない。実行ログに残っている差分、検証・Review の記録は利用できるが、当時のコード状態の再現や変更の正確な帰属は保証しない。

### 再集計と中断

- 同じ Root Session ID は同じ実行として更新する。別 Session ID は別実行として追加する。
- コマンドを打ち忘れた実行も、対応情報と既存ログが取得できれば集計する。
- 保存済みの集計結果は保持する。原ログの消失だけを理由に以前集計した実行を消さず、現在の取得不足を示す。保存済み JSON と原ログの読み直しをどう組み合わせるかは Planning で具体化する。
- 同じ Session を開き直した場合、Pi に追加されたログを次回集計で同じ実行に反映する。Evaluation が中断前の収集状態を復元する処理はない。
- 中断をまたいだ Tool の開始・終了や結果の対応が確認できない場合は、その部分を不明とする。

会話 tree の巻き戻し・分岐を含む実行は対応範囲外とする。branch ごとの実行選択・追従・復帰は行わず、検出できた場合はその制限を表示する。無関係な枝の成果や承認を混ぜて通常の実行として説明しない。検出可能な操作と集計境界は Planning で確認する。

## 5. コマンドと成果物

Pi 上の手動コマンドで対象 Taskflow を選び、集計・レポート生成を行う。日常操作で内部 ID の記憶・手入力は必須にしない。Taskflow の表示名、対象 Issue、日時等を選択の手掛かりにする。UI が利用できない場合の指定方法は Planning で定める。

```text
関連付け情報と既存ログ
    ↓
Taskflow の集計データ（JavaScript のオブジェクト・配列）
    ├─ JSON として保存
    └─ 同じデータから HTML を生成・保存
```

成果物はプロジェクト内の `.pi/taskflow-reports/` に保存する。Taskflow ごとに分ける。配置の基本形は次のとおり。

```text
.pi/taskflow-reports/
└─ <taskflowId>/
   ├─ report.json
   └─ report.html
```

JSON は HTML と同じ集計データであり、独立した評価結果・評価 ID・評価履歴を作らない。再集計で現在のレポートを更新する。schema の具体形と、安全に更新・読み取るための検証は Planning で定める。過去の途中実装が作った Evaluation 保存形式との互換・移行は要件にしない。

HTML は、一つの Taskflow の Planning / Issue / 各実行を辿れる、ローカルで開ける自己完結型とする。外部 CDN は必要としない。ログ・子 Agent 出力は実行可能な HTML として扱わず escape する。未知の URL scheme や任意ローカルファイルを開く機能を追加しない。厳密な Timeline や品質スコアは要求しない。

レポートには集計時点、対象 Taskflow と各 Session、利用した証拠の参照、取得できない部分を示す。集計後に別実行が進んでもレポートは自動更新せず、次の手動集計で反映する。

## 6. 保存と安全条件

- `.pi/taskflow-reports/` は Git 管理対象から除外する。この repository は現在 `.gitignore` で `.pi/` を除外している。他プロジェクトへの導入時にも除外状況を確認する。
- JSON / HTML はログ由来の機密情報を含み得る。ユーザー専用の権限で保存し、外部送信・公開を自動で行わない。
- 集計に必要な内容だけを残す。既知の認証情報等は出力前に秘匿化し、未知の秘密の完全除去は保証しない。秘密専用ファイルや認証設定を追加で読み取らない。
- 読み取り対象・書き込み先の path、symlink、入力 schema を検証する。公開ログの参照先であることと、安全に読み取れることを確認する。
- 大きなログ・結果を無制限にメモリへ読み込まない。読み取り・表示・出力の上限と省略方法は Planning で定め、省略を隠さない。
- 元の Pi / `pi-subagents` ログ、Issue、Plan、対象コードは集計によって変更・削除しない。関連付け情報の `CustomEntry` 追加以外に、Session の内容を書き換えない。
- 読み取り・生成・保存の失敗を知らせ、既存レポートを失敗処理で削除しない。複数実行で同じ出力先を更新する場合の扱いは、必要最小限の保存契約として Planning で定める。
- 専用の削除機能や保存期限管理は初版の要件にしない。集計処理が動いていないときにレポート領域を手動削除できる。削除しても原ログは残るが、再生成できる範囲はその時点で取得できる記録に限られる。

## 7. Planning で具体化する事項

主要な方針は本書に定める。以下は、公開 API の確認、限定的な実験、必要なユーザー判断を経て具体化する。確認できない部分を推測で埋めず、成立しない前提があれば基本設計への影響を報告する。

| 項目 | 確認・判断する内容 |
| --- | --- |
| 関連付けの契約 | Taskflow ID の発行、`CustomEntry` の識別名・最小データ、通知 Tool と Skill の接点、重複・矛盾の扱い。既存 Issue の再計画を行う Planning の所属方法は未決。手戻りの全体を同じ Taskflow で辿れる範囲に影響するため確認する |
| ログ取得 | 対象プロジェクトの Session 列挙、対応情報の抽出、子の公開参照と親の照合、利用可能な Artifact、保持・消失、対応バージョン、会話 tree 操作の検出範囲 |
| 集計・再集計 | 表示に必要な記録の抽出範囲、終了申告の表示、Session ID による重複防止、保存済み結果の保持、時刻・Usage の出典と不足、JSON の最小データ契約 |
| 操作・保存 | コマンドと選択 UI、非 UI 時の指定、HTML の構成、サイズ上限・秘匿化、安全な参照・出力更新、保存権限と `.pi/` の Git 除外 |

基本設計は、新規実装の入力とする。既存の部分実装を修正・互換維持する計画にはしない。コードの削除・新規実装、Taskflow の Skill への通知追加、Issue の作成・更新は、今後作る Approved Plan と別途の実行許可に従う。本書の保存だけでは実行しない。

### 期待する結果を確かめる観点

- Planning と複数 Issue の実行が、一つの Taskflow にまとまる。
- Issue #2 の終了時にコマンドを実行しなくても、後の集計で #2 を含められる。
- 同じ Session の再集計は重複せず、同じ Issue の別 Session の再実装は区別される。
- Root と子の依頼・結果・Review が、既存の対応情報を根拠に辿れる。
- 停止・失敗・途中実行、未登録、ログ欠損、切り詰めを成功や使用量ゼロに置き換えない。
- JSON と HTML が同じ集計内容を表し、ログ内の HTML 等が実行されない。
- 集計で新しいモデル呼び出しが発生せず、Taskflow の承認・進行と原ログを変えない。
- 読み取り・保存失敗やレポートの削除で、対象コードや既存の成果物を失わない。

## 8. 確認した根拠と制約

確認日: 2026-10-13。相対パスは本 repository のルートを基準とする。Pi のインストール済み資料は `/Users/minoru/.local/share/mise/installs/pi/1.1.0/`、`pi-subagents` の資料は `/Users/minoru/.pi/agent/npm/node_modules/pi-subagents/` 配下を確認した。

- `../pi-taskflow/skills/taskflow-planning/SKILL.md`、`../pi-taskflow/skills/taskflow-implementation/SKILL.md`、`../pi-taskflow/skills/taskflow-to-ticket/SKILL.md` と `../pi-taskflow/skills/taskflow-to-ticket/references/templates/ticket.md` を確認した。Planning と Implementation は別の新しい Root Session、Work Item は一回の Implementation を基本とする。チケットは正式な Plan の参照を持つが、当時の Plan 全文の不変保存は必須契約ではない。
- `../pi-taskflow/extensions/taskflow.ts` を確認した。現在の Extension は Plan / Code Review Tool を提供し、Session と Issue / Taskflow の構造化対応情報は残していない。確認時の隣接 checkout は `0a7469d`。
- Pi 1.1.0 の `docs/session-format.md`、`message-types.md`、`sdk.md` と `examples/sdk/11-sessions.ts` を確認した。Session は JSONL で ID / cwd を持ち、`CustomEntry` は非会話データとして保存される。公開 SessionManager に Session の列挙・取得がある。
- 開発依存 Pi 1.1.0 の公開型で `ExtensionAPI.appendEntry()`、`SessionManager.appendCustomEntry()`、Session ID 取得・列挙を確認した。CustomEntry の追加と事後取得をつなぐ実動作はまだ検証していない。
- このプロジェクトの Root Session ログ18件を読み取り専用で確認した。Implementation の入力や Issue 取得コマンドは残るが、専用の Taskflow / Issue 対応 entry はなかった。既存の未登録ログを、会話から推測して自動登録する方式は採用しない。
- インストール済み `pi-subagents` 0.77.0 の `docs/observability.md`、`extension-api.md` を確認した。親子の参照、公開 result / metadata / transcript / Session / lifecycle Artifact を利用できる。一部は一時領域にあり、完了通知用 result の削除や Artifact の期限切れがある。field 名だけで ID 種別や存在を保証しない。
- 対象 Issue の実例として https://github.com/minorunakamura/pi-taskflow-evaluation/issues/5 と、その Plan 全文参照先 https://github.com/minorunakamura/pi-taskflow-evaluation/issues/2 を確認した。Issue には実装内容・完了条件・検証方法がある。後日の取得内容を実行当時の内容と同一視しない。
- 本 repository の `package.json` は Pi 1.1.0、TypeScript / TypeBox / Vitest と `pnpm check` を使う。プロジェクトの tracker は `docs/agents/issue-tracker.md` に GitHub Issues として設定済み。既存の開発規約・チェックを再利用し、不要な依存や infrastructure を追加しない。

この確認は、関連付け情報の登録から自動発見・子ログ取得・累積集計・JSON / HTML 出力までの一貫した動作検証ではない。特に未集計の実行の発見、CustomEntry の永続化、会話 tree 操作、Artifact 消失後の再集計、安全な出力更新は今後の Planning で確認する。
