# eumenes-steer

実行中に届いた補足の参照を、次の推論入力まで保持する小さなインメモリ部品です。Bun 1.4.4向けのTypeScriptソースを配布し、実行時依存はありません。

## 導入

TGZを導入先の `vendor/steer/` に置き、導入先の `package.json` に相対パスで指定します。`<sha12>` はファイル名のSHA-256先頭12桁です。

```json
{
  "dependencies": {
    "eumenes-steer": "file:vendor/steer/eumenes-steer-0.1.0-<sha12>.tgz"
  }
}
```

`bun install` で導入し、`package.json` と `bun.lock` をTGZと一緒に管理します。

## 使用例

```ts
import { createSteeringInbox } from "eumenes-steer";

const inbox = createSteeringInbox();
const opened = inbox.open("run-42", "1");
if (opened.status !== "opened") throw new Error(opened.status);

const sources = new Map([
  ["work-result-5", { revision: "3", text: "資料を確認済み" }],
]);
const { target } = opened;
try {
  const result = target.enqueue({
    id: "event-1",
    sourceRef: "work-result-5",
    sourceRevision: "3",
  });
  if (result.status !== "accepted") throw new Error(result.status);

  // 最終の推論入力を組み立てる直前に受付を締める。
  target.seal();
  const claimed = target.claim("answer");
  if (claimed.status === "claimed") {
    const supplements = claimed.batch.events.flatMap((event) => {
      const source = sources.get(event.sourceRef);
      return source?.revision === event.sourceRevision &&
        Date.now() < event.expiresAt
        ? [source.text]
        : [];
    });
    console.log(supplements); // この例ではモデルへの入力を表示する。
    target.settle(claimed.batch.id, "committed");
  }
} finally {
  target.close();
}
```

実際の導入先は出典・権限・入力予算を確認します。入力の受理を確認したら `committed`、確実に渡していなければ `released`、受理の有無が不明なら `unknown` で確定します。入力の引き渡しとモデル出力の採用は別の時点です。

- `claim` は受付順のスナップショットを返し、同時に取得できるのは1バッチです。`released` の後に同じ境界で取り直すと、元の集合のうち期限内のイベントを取得します。別の境界では新着と合わせて受付順に取得します。次の境界に進んだホストは、前の境界IDの使用を終えます。`unknown` は自動再送から外します。
- `open` は同じ対象・世代の有効なハンドルを再利用します。世代を切り替えるときは旧ハンドルを `close` します。バッチIDは同じプロセスで使う `symbol` です。
- 既定の上限は対象256件、対象ごとの保留32件、世代ごとの異なるイベントID累計512件、識別子と出典の各フィールド256 UTF-8バイトです。取得中のイベントも保留枠を使います。
- TTLは既定・最大とも10分です。`expiresAt` は絶対ミリ秒時刻で、受付時刻から最大TTLまでに丸めます。同一IDの再送は、出典・版・指定期限が同じ場合に `duplicate`、違う場合に `conflict` となります。期限は再送で延長されません。
- `close` は未確定のバッファ件数を返して破棄します。プロセスの再起動後は空のInboxから始まります。補足本文は導入先の正本に保存します。

## 開発と配布

`bun install --frozen-lockfile` の後、`bun run verify` で型・整形・lint・試験、`bun test --coverage ./test` でカバレッジを確認します。`bun run pack:check` は、別フォルダでTGZをオフライン導入して型検査と試験を行い、移動後の再導入まで通ったTGZを `dist/` に置きます。
