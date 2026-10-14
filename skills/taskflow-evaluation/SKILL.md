---
name: taskflow-evaluation
description: Taskflow の確認済み Planning/Issue 参照を optional に通知し、記録済み Session 候補と不足を確認する。Taskflow 関連付けや /taskflow-evaluate --list を求められたときに使う。品質判定・承認・完了認定は行わない。
---

# Taskflow Evaluation（W1）

現在利用できるのは `taskflow_evaluation_link` と `/taskflow-evaluate --list`。レポート生成・保存済み JSON の所属統合（W2）、子本文取得（W3）、隣接 Taskflow Skill 通知接点（W4）は未実装。対応済みとは案内しない。詳細な契約・上限・導入はこの Skill directory から `../../README.md` を読む。

## optional 通知

Tool がモデルに提示され利用可能な場合だけ、通常の user message が原ファイルに保存された新しい Root Session で使う。不可・失敗・未通知でも Taskflow の進行・承認条件を変えず、代替 manifest を作らない。

- 目的の確認後、新規 Planning: `{"operation":"begin_planning","displayName":"目的"}`。
- 再計画: 同じ入力に、通常の取得で確認した既存 Issue の `sourceIssues` を追加。Taskflow ID を手入力しない。
- 保存・公開承認後、作成・取得確認済みの参照だけ: `{"operation":"add_issues","issues":["https://github.com/owner/repo/issues/1"]}`。部分作成や既存再利用も確認済み部分だけ。
- 別の新しい Implementation Root Session で対象取得後、Worker 起動前: `{"operation":"implementation","issue":"https://github.com/owner/repo/issues/1"}`。

GitHub https Issue URL または明示構造 `{kind:"github",host,owner,repo,number}`、local project-relative ticket path または `{kind:"local",path}` を使う。番号だけ・タイトル・意味・時刻から所属を推測しない。local ticket は cwd 内の既存 regular file。traversal / symlink escape は拒否する。displayName は160文字、refs は100件、CustomEntry は64 KiBまで。

`status: saved` は原 Session の有効 entry で確認された登録。`save_unconfirmed`、pending、非永続、append 失敗を成功に変えない。同じ通知を再試行しても原登録は変わらない。memory-only の通常 message / CustomEntry は保存証拠ではなく、現在の leaf が原ファイルに確認できなければ Evaluation の追加を停止する。原 Session を Pi の通常の reload/resume で確認してから再試行する。Extension は原ログを修復しない。

再計画は全 sourceIssues の明示対応が一意かつ同じ Taskflow の場合だけ既存 ID を再利用する。不明・一件不足・複数所属・異所属・探索未完了は `planning_source_issues_unresolved` を返し、CustomEntry / pending 状態を追加せず、新 UUID で回避しない。後日明示対応が得られた場合の通常の通知は可能だが、自動再試行・再解決はない。正規の旧 version 1 unresolved begin の sourceIssues / add_issues を所属に昇格させず、別の明示対応を block しない。旧 Session の begin 再通知 / add_issues は拒否し、原記録を再保存・移行しない。不正な旧形・未知 version は救済しない。別 phase / 別 Implementation Issue / 別 Taskflow への同じ Session 内の切替はしない。

## 手動一覧

利用者に `/taskflow-evaluate --list` の実行を案内する。Tool の代用として bash で command の内部処理を再実装しない。この command 自体は idle 待ち後に read-only で動作し、新しい model turn を起こさない。UI なしでは stdout の `TASKFLOW_EVALUATION_RESULT ` に続く完全な一行 JSON receipt と末尾 LF を確認する。Pi の instance `write` redirect を避け、既存 stdout への公開 Writable write の callback を待ち、書込失敗は呼出元へ伝播する。stdout を終了・破棄せず、独自 retry / queue はない。callback は chunk 完了であり、読了 ACK / 永続化保証ではない。CLI exit code / RPC handled だけを成功証拠にしない。

- `complete: false`、warnings、unresolved を不足として伝え、一意所属を断定しない。
- 上限超過は receipt の `taskflow-evaluation.limits.<key>` を利用者が変更し `/reload` 後に再実行。独自 settings reader、無制限 fallback、原ログ削除・間引きを使わない。
- `missingImplementationIssues` は実行記録が見つからないという意味であり、未実施とは断定しない。
- 現在 cwd / 現在 Session directory の top-level JSONL のみが対象。scope 外の矛盾、未記録 navigation、未登録会話は未知。
- `jsonCommitted` / `htmlUpdated` は W1 では false。保存成功、評価・品質・承認・完了を認定しない。Issue 指定・選択 UI・report/HTML の利用手順は未実装として説明する。

W1 の負荷検証条件は100 Planning + 100 Implementation Sessions、Issue refs は全体で100件（各 Planning に異なる1件）。旧2000 Sessions / 100000 refs の約18 MB receipt にある EAGAIN / ERR_SYSTEM_ERROR 切断を、縮小負荷や合成出力の成功だけで修正済み・検証済み・保証済みと説明しない。

通知 payload や displayName に秘密を含めない。原 Session に保存されるため、Evaluation が外部送信しないことは秘密の保存防止を意味しない。
