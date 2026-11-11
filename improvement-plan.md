# Eumenes Steer 改善計画

2026-11-11。P1（Inbox本体と単独TGZ）の評価で見つかった改善をまとめる。対象はSteer単体。完了後に [実装計画](plan.md#6-実施順序と完了条件) のP0へ進む。

## 1. 現状と範囲

評価時点で `bun run verify`、`bun test --coverage ./test`（行・関数100%）、`bun run pack:check` は成功している。TGZは再現可能で、SHA-256は `a48d61bd35be…`。Eumenesへは未導入で、`vendor/steer` も参照もない。状態機械に正しさのバグは見つかっていない。

この計画が扱うのは、Coreの契約の改善5件、ランダム試験、文書の同期、ローカルでのTGZ導入検証。Eumenesへの接続（P0・P2〜P4）は `plan.md` の範囲とする。

版は `0.1.0` のままとする。どの導入先も採用していないため、配布物はファイル名のSHA-256で区別する。

## 2. 決定事項

| # | 現状 | 決定 |
| --- | --- | --- |
| I1 | ハンドルを得る手段が `open` だけで、`open` は対象を作る。受信側が閉じた後に送信側が `open` すると、誰も閉じない対象が残り、`maxTargets` を消費する | 対象を作らない送信入口 `inbox.enqueue(targetId, generation, event)` を追加する |
| I2 | 導入先が `exactOptionalPropertyTypes` を有効にすると、旧実装の `seen` への保存で型エラーになる | I3の変更で解消する。同じフラグを開発ツリーと `pack:check` の導入先に加えて再発を防ぐ |
| I3 | 同じIDの再送で `expiresAt` が違うと `conflict` になる。期限を「現在＋60秒」のように毎回計算する送信元は必ず衝突する | 同一性の判定を `id`・`sourceRef`・`sourceRevision` に限る。再送の `expiresAt` は使わず、最初の期限を維持する |
| I4 | `close()` の件数が、期限切れ分の掃除が先に走ったかどうかで変わる | 「受理したが `committed`・`unknown` で確定しなかった件数」に定義を変える。期限切れを含み、時計を読まない |
| I5 | `now` に関数以外を渡すと、生成時ではなく最初の `enqueue`・`claim` で失敗する | 生成時に `TypeError` を投げる |
| I6 | 試験はすべて固定シナリオ | 乱数の種を固定した操作列で不変条件を確かめる試験を追加する |

## 3. 変更内容

### I1 送信入口

```ts
export interface SteeringInbox {
  open(targetId: string, generation: string): SteeringOpenResult;
  /** 開いている対象へ登録する。対象を作らない。 */
  enqueue(
    targetId: string,
    generation: string,
    event: SteeringEvent,
  ): SteeringSendResult;
}

export interface SteeringSendResult {
  readonly status:
    | SteeringEnqueueResult["status"]
    | "invalid_target"
    | "not_open"
    | "generation_conflict";
}
```

- 識別子が不正なら `invalid_target`、対象がなければ `not_open`、別の世代が開いていれば `generation_conflict`。それ以外はハンドルの `enqueue` と同じ結果を返す。
- 送信側には `inbox.enqueue` だけを渡す。ハンドルは取得・確定・終了を含むため、受信側が持つ。
- `open` は対象を作る操作として残す。Pursuitの「送信が最初ならコミット済みの行を検証して開く」経路は、ホストが検証した後に `open` を使う。 [Pursuitの次手判断](design.md#4-pursuit-の次手判断)
- 世代は任意の文字列で、Coreは新旧を判定できない。閉じた世代や古い世代の開き直しを防ぐのはホストの責務とし、READMEに明記する。現在の挙動は試験で固定する。
- 名前と結果の形はP2の結合結果で最終確定する。

### I2・I3 重複の判定と型

- [重複検査](src/inbox.ts#L96-L114) の `seen` を `Map<string, { sourceRef: string; sourceRevision: string }>` にする。`expiresAt` を保存しないため、I2の型エラーも消える。
- 期限は再送で延びも縮みもしない。出典の取り消しは、取得時のホストの出典検査で扱う。
- [既存試験](test/inbox.test.ts#L100-L136) の `expiresAt` 違いの期待値を `duplicate` に変える。出典・版の違いは `conflict` のまま。
- `tsconfig.json` と [pack-check.ts](scripts/pack-check.ts#L58-L72) の導入先設定に `exactOptionalPropertyTypes` と `verbatimModuleSyntax` を加える。
- 対応する解決方式は `moduleResolution: Bundler`。`NodeNext` は拡張子なしの相対importで失敗するため、READMEに前提として書く。

### I4 `close()` の件数

- ハンドルに確定済み件数のカウンタを置き、`committed`・`unknown` でバッチの件数を足す。`close()` は `seen.size − 確定済み件数` を返す。
- 既存試験の期待値（2、1、0）は変わらない。期限切れの後に掃除あり・なしの2ケースを追加し、どちらも同じ件数になることを確かめる。
- [contracts.ts](src/contracts.ts#L71) のコメントとREADMEの記述を新しい定義に合わせる。

### I5 `now` の検査

- [settings](src/inbox.ts#L35-L36) で `typeof now !== "function"` なら `TypeError`。戻り値の検査は現状のまま。

### I6 ランダム試験

`test/inbox.model.test.ts` を追加する。依存を増やさず、試験内の小さな擬似乱数で `enqueue`・`claim`・`settle`・`seal`・時刻の進行をランダムに並べる。種は固定の一覧とし、失敗時に種と操作列を出力する。`verify` の所要時間は1秒以内に保つ。

確かめる不変条件は次の6つ。

1. 保留と取得中の合計は `maxPendingPerTarget` 以下。
2. バッチ内の順序は受付順。
3. `committed`・`unknown` で確定したイベントは二度と取得されない。
4. 期限切れのイベントはバッチに入らない。
5. `released` 後の同じ境界の取得は、元の集合の部分集合。
6. `close()` は受理件数から確定済み件数を引いた値。

### 文書

- README、[plan.md §3](plan.md#3-inboxの契約)、[design.md §2](design.md#2-inbox-と推論への引き渡し) の契約の記述を実装と同時に更新する。

## 4. 実施順序と完了条件

| 順 | 作業 | 完了条件 |
| --- | --- | --- |
| 1 | I3とI2 | 期限だけ違う再送が `duplicate`、最初の期限を維持。`exactOptionalPropertyTypes` 付きで `bun check` が通る |
| 2 | I4 | 掃除の有無で `close()` の値が変わらない |
| 3 | I1 | 閉じた対象・別世代・不正な識別子への送信がそれぞれの理由で返り、対象数が増えない。開いている対象への送信はハンドル経由と同じ結果 |
| 4 | I5 | `now: 5` で生成時に `TypeError` |
| 5 | I6 | 固定した種の全操作列で不変条件が成立。I1〜I4を一時的に戻すと、対応する試験が失敗することを確認 |
| 6 | 文書の同期 | README・`plan.md`・`design.md` の契約表と実装が一致 |
| 7 | 最終確認 | `bun run verify`、カバレッジ80%以上、`bun run pack:check` が成功。独立したレビューを1回行い、指摘をまとめて直す。新しいTGZのSHA-256を記録する |

順1〜5は同じ `src/inbox.ts` と `test/inbox.test.ts` を変更するため、並行させず順に行う。

## 5. 見送る項目

- **時計の巻き戻り対策。** `now` の最大値を保持して単調にすると、時計が一度先へ飛んで戻った場合にInboxの時刻が進んだままになり、明示した `expiresAt` が受理されなくなる。`expiresAt` はホストと共有する壁時計の絶対時刻なので、精度は壁時計に従うとREADMEに書く。
- **対象の自動回収と一覧API。** I1で送信による作成がなくなり、残るのはホストが `close` を呼び忘れる場合に限られる。P2で `target_limit` の調査に必要になった時点で、件数の参照を検討する。
- **閉じた世代の記録。** 対象ごとに閉じた世代を残すと、上限のない記憶が必要になる。ホストの責務とする。
- **`NodeNext` 対応、部分確定API、プロセス間配送。** `plan.md` の範囲外のまま。

## 6. 実装・検証結果

- ローカルのBun 1.4.4で `bun run verify` が約0.14秒で成功。固定シード8種、計1,280操作を含む24件が通り、Coreの行・関数カバレッジは100%。
- 隔離コピーでI1〜I4を個別に旧挙動へ戻し、対応する試験または型検査が想定どおり失敗することを確認。実装後の差分点検で、無効な期限の試験が期限検査まで届くよう修正した。
- `bun run pack:check` で、別フォルダへのオフライン導入と移動後の再導入を確認。どちらも厳格な型設定での型検査と24件の試験が成功。
- 配布物は `eumenes-steer-0.1.0-1ca04b8bee9b.tgz`。SHA-256は `1ca04b8bee9b839016a14987fc903282c1b57665eca1e89457681c3990f1e705`。
