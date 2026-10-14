---
name: taskflow-evaluation
description: Taskflow の確認済み Planning/Issue 参照を optional に通知し、手動で Root の出典付き JSON/HTML レポートを集計する。関連付け、候補一覧、レポート・再集計を求められたときに使う。品質判定・承認・完了認定は行わない。
---

# Taskflow Evaluation

`taskflow_evaluation_link` と `/taskflow-evaluate` を使う。子は明示参照だけで、本文 / Artifact 取得（W3）、隣接 Taskflow Skill 通知接点（W4）は未実装。詳細な導入・設定・安全性契約はこの Skill directory から `../../README.md` を読む。

## optional 通知

Tool がモデルに提示され利用可能な場合だけ、通常の user message が原ファイルに保存された新しい Root Session で使う。不可・失敗・未通知でも Taskflow の進行・承認条件を変えず、代替 manifest を作らない。

- 目的の確認後、新規 Planning: `{"operation":"begin_planning","displayName":"目的"}`。
- 再計画: 同じ入力に、通常の取得で確認した既存 Issue の `sourceIssues` を追加。Taskflow ID を手入力しない。
- 保存・公開承認後、作成・取得確認済みの参照だけ: `{"operation":"add_issues","issues":["https://github.com/owner/repo/issues/1"]}`。部分作成や既存再利用も確認済み部分だけ。
- 別の新しい Implementation Root Session で対象取得後、Worker 起動前: `{"operation":"implementation","issue":"https://github.com/owner/repo/issues/1"}`。

GitHub https Issue URL または明示構造 `{kind:"github",host,owner,repo,number}`、local project-relative ticket path または `{kind:"local",path}` を使う。番号だけ・タイトル・意味・時刻から所属を推測しない。local ticket は cwd 内の既存 regular file。traversal / symlink escape を拒否する。displayName は160文字、refs は100件、CustomEntry は64 KiBまで。

`status: saved` は原 Session の有効 entry で確認された登録。`save_unconfirmed`、pending、非永続、append 失敗を成功に変えない。同じ通知は冪等で、phase / Implementation Issue / Planning の Taskflow・目的・sourceIssues の切替は拒否する。memory-only message / CustomEntry の leaf は保存証拠ではない。原 Session を Pi の通常の reload/resume で確認してから再試行し、独自 queue / flush / 原ログ修復をしない。

再計画は保存済みの検証済み明示 link proof と今回の有効通知から、全 sourceIssues の所属が一意かつ同じ Taskflow の場合だけ既存 ID を再利用する。不明・一件不足・複数所属・異所属・探索未完了は `planning_source_issues_unresolved` とし、CustomEntry / pending 状態や回避 UUID を追加しない。正規の旧 unresolved begin の sourceIssues / add_issues を所属へ昇格せず、別の明示対応を block しない。旧 Session の begin 再通知 / add_issues / phase 切替を拒否し、原記録の再保存・補完・移行・復元・自動再解決をしない。

## 手動集計

利用者に command の実行を案内する。Tool の代用として bash で内部処理を再実装しない。

1. `/taskflow-evaluate --list` は現在 cwd / Session directory の top-level JSONL と同 scope の有効 saved report を read-only で一覧化し、report / lock を作らない。
2. TUI / RPC の `/taskflow-evaluate` は候補を select する。取消は保存しない。
3. 非 UI は `/taskflow-evaluate https://github.com/owner/repo/issues/1` または project-relative ticket path。補助指定 `/taskflow-evaluate --taskflow <UUID>` も使える。無指定・曖昧・探索未完了で推測保存しない。
4. idle 待ち後に新しい model turn / conversation message を追加せず、read-only で取得する。原 Session / Artifact / Issue / Plan / コードを変更しない。

UI なしでは stdout の `TASKFLOW_EVALUATION_RESULT ` に続く完全な一行 JSON receipt と末尾 LF を確認する。公開 Writable write の callback を待ち、失敗は呼出元へ伝播する。stdout を終了・破棄せず、独自 retry / queue はない。callback は chunk 完了であり読了 ACK / 永続化保証ではない。CLI exit / RPC handled だけを成功証拠にしない。

receipt の target (`taskflowId`)、files、digest、warnings / errorCode / resume、`jsonCommitted` / `htmlUpdated` を分けて伝える。`partial_success` は JSON committed / HTML stale または unavailable であり完全成功ではない。`complete:false`、未登録・所属不明・conflict・取得不足を説明し、`missingImplementationIssues` を未実施と断定しない。保存 container の UUID は所属不明 Root の通常成果への採用根拠ではない。

## レポートの読み方

固定先 `.pi/taskflow-reports/<UUID>/report.json` は schemaVersion 1 の正本、`report.html` は同 object / contentDigest の静的派生ページ。script / CDN / network / 自動ブラウザ起動はない。JSON の Planning / Issue refs と Issue ごとの Root 実行・見つからない記録の個別表示を確認し、見出し・Issue→Root の内部 anchor・details で証拠を辿り、HTML 単体で最新 JSON との一致を確認できないことを伝える。

- 同じ Session は更新、同じ Issue の別 Session は別実行。未集計の中間実行も後で取り込める。
- request / assistant の報告 / Tool 観測 / unknown を区別する。READY_FOR_MERGE 等の文章は報告値であり承認代行ではない。取得範囲内の最新報告は実行終了ではない。構造化 exitCode がある場合だけ終了値を引用し、isError=false / 成功文を0に置換しない。
- Usage は Root assistant / Tool nested / compaction / usage entry の出典と範囲別。欠損は未知で、総合計へ加算しない。子の runId / asyncId / path 等は参照のみ、本文未取得。
- ToolResult.details の JSON-safe な構造（Review / 承認結果を含む）を raw Tool 観測として保存し、entry / toolCallId / Tool 名で依頼・結果を辿る。Tool-specific schema を意味判断せず、Evaluation が approved を認定したとは説明しない。過度に深い・非 JSON の詳細は取得不足。
- system prompt / thinking / signatures / image payload は保存しない。非対応の実使用 field は取得不足を示し、有効な明示所属まで拒否しない。
- immutable な出典キー＋値を dedup し、改変値は両方と conflict を保持する。原ログ消失・短縮で保存証拠を削除せず、今回の availability を別に見直す。
- 正常な取得で保存した tree quarantine は短縮・消失で通常成果・Review・承認集計へ戻さない。duplicate ID / parent 欠損等で取得未完了なら検出理由と未更新を receipt に表示し、旧ペアを維持する。未更新操作の観測を独自復旧状態として保存しない。
- 一意性は限定 scope 内だけで、scope 外の矛盾・未記録 navigation は未知。

## 設定・機密性・復旧

`pi.getSettings()` の `taskflow-evaluation.limits` を開始時に snapshot する。独自設定 reader / watcher / 無制限 fallback はない。利用者が settings を変更して `/reload` 後に再実行する。全 defaults / keys は README の表を読む。

保存 JSON は `maxReportJsonMiB` で再読取し、一般 `maxFileMiB` と分ける。操作全体の `maxReadMiB` も適用する。設定を下げて既存 JSON が読めない場合や、未知・破損 schema は空データにせず停止する。merge 後の Root / records / JSON / HTML overflow でも旧ペアを保持し、receipt の key / value / 未反映範囲 / resume を案内する。証拠削除・間引きで解決しない。

report directory は0700、file / temp / lock は0600。symlink / regular file / containment / parents / fstat を検証する。Git repository では利用者が `.pi/taskflow-reports/` を ignore し、tracked file を含めない。Extension は ignore / index を変更しない。非 Git は notice。既知 Authorization / Bearer / token / API key / password / URL credential / private key と構造化 sensitive key を秘匿化するが、**未知秘密の完全除去は保証しない。report を公開しない。** 通知 payload / displayName にも秘密を含めない。原 Session は秘匿化せず保持する。

- **上限超過:** 指定 key を変更、`/reload`、再実行。JSON 上限だけで足りなければ maxReadMiB も確認。
- **JSON 破損:** 正常 backup を戻す、または対象 directory を別のユーザー専用・Git 除外済み場所へ手動退避して再生成。消失済み原ログの証拠は再生成できないことを先に通知。
- **tracked / ignore 不足:** 利用者が ignore を修正し `git rm --cached` で対象を index から外して確認。過去 commit / push の秘密は別途失効・履歴対応。
- **残留 lock:** 集計が動いていないことを確認してから手動で report.lock を除去。foreign / stale lock を自動解除しない。
- **HTML 部分失敗:** 同じ対象の再集計で JSON から修復。JSON を削除・rollback しない。既存 HTML digest mismatch / unavailable は警告される。
- **path / permission / settings / redaction:** 該当理由を修正して再実行。安全性を無効化する fallback はない。

両 temp が生成されるまで旧成果物を変更せず、JSON rename commit 後に HTML rename。2ファイル同時 atomic 更新・電源断耐性は保証しない。

W1 の負荷検証条件は100 Planning + 100 Implementation Sessions、Issue refs は全体で100件。旧2000 Sessions / 100000 refs の約18 MB receipt の EAGAIN / ERR_SYSTEM_ERROR 切断を、縮小負荷や合成出力の成功だけで修正済み・検証済み・保証済みと説明しない。UI 境界 stub と実 TUI / RPC / browser の直接検証を区別する。
