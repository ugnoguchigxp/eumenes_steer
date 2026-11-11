# Eumenes Steer 詳細設計

2026-11-11 · Steer本体と単独TGZを実装。ホスト接続は設計段階

実行中に届いた補足を、対象の実行が次に行う既存の推論へ渡す。初回は Eumenes の作業確認後の回答と、Pursuit の次手判断で共通の Inbox を使う。Agency の通常応答は Eumenes のモデル接続から取り込み、常時思考は既存の観測入力を使う。Collaboration は確定した制作条件を送る側から接続する。補足の関連性と、それを受けて何をするかは、既存の推論でモデルが判断する。 [実装計画](plan.md)

## 1. 調査対象と接続先

| フォルダと HEAD | 現行の実行経路 | Steer を接続する場所 |
| --- | --- | --- |
| `eumenes` · `4ed26d7f` | 発言受付がメッセージと Queue ジョブを作る。Router の `checkWork` は作業を読み、`turn.talk` が既存の回答推論を実行する | `dialogue.generate` の実行世代で受け付け、作業確認が成功した後の `chat.complete` で取り込む。 [発言受付](../eumenes/api/domains/dialogue/service/intake.ts#L164-L239) · [作業確認](../eumenes/api/domains/dialogue/service/routed-actions.ts#L143-L153) |
| `eumenes_pursuit` · `397795f` | Productive loop が判断要求を台帳に保存し、ホストが `decisionRequest` と `completeDecision` の間で推論する。保存済み計画から直接操作する経路もある | Eumenes の `pursuit.decision` ジョブの `model.complete` で取り込む。 [コアの境界](../eumenes_pursuit/src/domains/loop/engine.ts#L124-L145) · [計画の直接実行](../eumenes_pursuit/src/domains/loop/productive.ts#L364-L432) · [判断ジョブ](../eumenes/api/domains/pursuit/service/decision.ts#L38-L69) |
| `eumenes_agency` · `766e15e` | `runRespond` は `chat.complete` を呼び、読み取りツールの結果を履歴に足して再度呼べる。Always-on は `observe` と `tick` を使い、入力世代が変わると古い思考を失効させる | 通常応答はホストが渡す `chat` ポートで取り込む。常時思考の発言・訂正・忘却は既存の feed と出典検査で扱う。 [応答ループ](../eumenes_agency/src/application/respond.ts#L131-L216) · [常時思考](../eumenes_agency/src/always-on/agent.ts#L391-L556) |
| `eumenes_collaboration` · `b034262` | ライブラリはモデル入力と提案検査を提供する。Eumenes の writer が専門セッションの状態と制作物を確定する | 確定後に制作物・条件の版を通知する。将来の受信境界は `specialist-turn.runTurn` の各推論入力の組み立て。 [メッセージ組み立て](../eumenes_collaboration/src/agent/messages.ts#L11-L86) · [ホスト契約](../eumenes_collaboration/spec/host-contract.md) · [専門ターン](../eumenes/api/domains/dialogue/service/specialist-turn.ts#L434-L491) |

調査は各フォルダの作業ツリーを参照した。Eumenes の Pursuit 判断ジョブや Collaboration の承認コードには HEAD に含まれない変更がある。Eumenes が参照する TGZ と隣接フォルダの最新版は独立しているため、P0 では基準コミット、取り込む差分、`bun.lock` と採用 TGZ のハッシュを固定する。 [Eumenes の採用依存](../eumenes/package.json#L54-L60) · [Pursuit 0.0.7 の取込記録](../eumenes/spec/pursuit-productive-integration-2026-11-10.md)

## 2. Inbox と推論への引き渡し

`eumenes-steer` は、Bunで使う実行時依存ゼロのライブラリとする。TGZには `package.json`、README、InboxのTypeScriptソースを収録し、公開入口は `eumenes-steer` の1つ。`createSteeringInbox` と公開型を提供する。導入先は任意の文字列IDで実行と出典を対応づけ、自分のモデル入力境界で取得・確定する。以下のEumenes固有の配線、出典検証、推論受理の通知は、導入先のコードとして実装する。 [配布仕様](plan.md#5-構成と配布)

`server-services.ts` で Inbox を一つ生成し、Dialogue と `createToolchain` 内の Pursuit に渡す。対象 ID はホストで `dialogue:<runId>` と `pursuit:<runId>` に名前空間を分ける。送信側はホストが検証した対象への登録だけを行い、受信側は対象を開閉してバッチを取得する。Core は同一プロセス内の順序、期限、重複、取得権だけを管理する。本文と権限は各ドメインの正本に置く。 [サーバー構成](../eumenes/api/application/server-services.ts) · [Pursuit の組み立て](../eumenes/api/application/toolchain/toolchain.ts#L416)

~~~text
既存 writer が出典と版を確定
  → ホストが対象実行とアクセス権を照合
  → Inbox にイベント ID・出典参照・版・期限を登録
  → 既存推論の入力組み立てで claim
  → 正本と版を再確認し、動的入力と推論 refs を同時に確定
  → Inference が凍結した入力を受理
  → 既存の配信・採用・操作確定で権限と出典を再確認
~~~

| 操作 | 初回の契約 |
| --- | --- |
| `open(targetId, generation)` | 現在の対象のハンドルを発行。同じ世代の二重 open は既存ハンドルを返す。異なる世代が開いている場合は拒否し、ホストが旧世代を閉じてから開く。ハンドルの識別子も照合するため、同じキーを開き直しても旧ハンドルから操作できない |
| `enqueue(event)` | `id`、`sourceRef`、`sourceRevision`、任意の絶対時刻 `expiresAt` を受理。受付順を割り当て、受理・重複・同 ID 衝突・期限切れ・上限・締切後・旧世代を区別する。再送で TTL を延ばさない |
| `claim(boundaryId)` | 受付順の非空スナップショットと一意な `batchId` を返す。空、取得中、確定済み境界を区別する。取得中の追加は次の境界へ回る |
| `settle(batchId, outcome)` | `committed` と `unknown` は対象イベントを保留から除き、境界を閉じる。`released` は再取得可能。同じ境界の再取得は元の集合と順序を維持し、新トークンを発行する。別の境界へ進めば未引き渡し分を新着と受付順で取得する。失効・期限切れ分は解決時に除く。古い取得権・二重確定は状態を変えない |
| `seal()` / `close()` | `seal` 後も保留分を取得できる。`close` は保留・取得中の未確定分を数えて破棄し、ハンドルを失効させる。正本へ残ったメッセージ、制作条件、作業結果は既存経路から再利用できる |

上限は `plan.md` の対象256件、保留32件、異なるID累計512件、文字列ごとに256 UTF-8バイト、TTL最大10分を採用する。保留枠には取得中を含め、期限切れの未取得分は枠の判定前に除く。期限が切れたイベントの ID は世代終了まで重複検出に残す。バッチ中に有効な出典がゼロになった場合は既存入力だけで進め、その入力の受理時にバッチを確定して補足の引き渡し件数をゼロと記録する。正本の一時的な読取失敗、または有効分全体が入力予算に収まらない場合は引き渡し前に `released` とする。個々の出典の状態はホストが記録する。 [上限と期限](plan.md#3-inboxの契約)

### 入力確定と受付の観測点

1. ホストは `claim` 後、送信する出典の識別子・版・失効検査に必要な情報をスナップショットとして持つ。確認済みの同一出典は履歴、作業結果、Steer の重複を除く。補足は動的入力へ置く。参考資料は明示的に未信頼データとして扱い、正式なユーザー補足を追加する段階では保存済みの利用者発言として扱う。
2. Dialogue では既存のメッセージ推定量、Pursuit では JSON 化した packet の推定量を使い、補足全体が既存の入力上限と出力予約の余白に収まるか確認する。履歴を削って補足枠を作らず、収まらない場合は補足を外して同じ既存推論を進める。最後の境界であれば未反映として閉じる。P0 で既存入力と試験ルートの上限を測り、P2 で上限直前の固定ケースを置く。 [トークン推定](../eumenes/api/infrastructure/context-budget.ts#L55-L78) · [クラウド側の入力調整](../eumenes/api/domains/inference/service/cloud.ts#L65-L125)
3. 現行の `executeStream` と `executeControl` は結果の Promise を返す。推論要求の予約や attempt 行の作成は、凍結した入力を推論実行が引き受けたことの通知にはならない。P2 では両者が合流する `executeRequest` に任意のホスト用フックを一つ置く。入力・ルート・要求の検査と実行登録の後、`runAttempts` の直前に、取消・出典・期限を最終確認し、その論理入力の受理を一度だけ同期通知する。フックの検査は受理通知に先立って行い、失敗した入力は provider に渡さない。補足だけが最終確認で失効し、実行と元の入力が有効な場合は、同じ推論予約の受理前として扱い、補足を外した既存入力で一度進める。実行や元の入力が失効していれば既存の取消処理を通す。 [共通の推論入口](../eumenes/api/domains/inference/service/index.ts#L372-L375) · [回答の入口](../eumenes/api/domains/inference/service/index.ts#L448-L471) · [推論実行の登録](../eumenes/api/domains/inference/service/execute.ts#L332-L463)
4. ホストは受理通知で `committed`、確実な受理前失敗で `released`、受理の有無を確定できない場合に `unknown` とする。`committed` は Eumenes の推論実行への引き渡しを表す。provider の成功、回答採用、ユーザーへの配信は既存の結果と照合する。provider のフォールバックや内部再試行は同じ入力・出典を使い、再取得しない。 [attempt と provider 呼び出し](../eumenes/api/domains/inference/service/execute.ts#L40-L168)

## 3. Eumenes の通常応答

### 開く・送る・閉じる

- `generation-handler.execute` で Queue が準備した `input.revision` と現在の running 状態が一致したときに、`runId + revision` を開く。Router が `checkWork` を選んだら `executor-work` が同じ会話内で解決した作業 ID を、その世代が購読する対象として登録する。読み取った `WorkRow.id/revision` を、表示文とともにホスト内部のメタデータとして返す。既存の `result` 文字列は維持する。 [実行開始](../eumenes/api/domains/dialogue/service/generation-handler.ts#L79-L119) · [作業の参照解決](../eumenes/api/domains/dialogue/service/executor-work.ts#L45-L111)
- 最初の製品候補は、作業確認で指定された画像生成の完了。画像の生成ジョブは `image.generate` の資源で動き、`inference.llm` を保持する回答中にも確定できる。作業行の `execution` と元の `runId` を照合し、`store.onCommit` で購読中の作業だけを確認する。画像ドメインの公開 `referenceInTransaction` が、コミット済みの `completed` と成果物 ID を返したときに登録する。イベント ID は画像の元 run と成果物 ID から作る。出典の版は確定した参照の digest、採用判定には作業行と有効な元発言の対応も使う。入力には完了状態と表示に必要な成果物参照だけを渡す。 [画像生成の Queue 登録](../eumenes/api/domains/image/service/index.ts#L33-L59) · [完了の writer](../eumenes/api/domains/image/service/handlers.ts#L339-L361) · [結果参照](../eumenes/api/domains/image/service/index.ts#L164-L181) · [コミット通知](../eumenes/api/infrastructure/sqlite/index.ts#L274-L294)
- `result-intake.intakeInTransaction` は通常どおり、後続の会話ジョブで作業台帳と通知を更新する。同じ会話の Queue キーで直列化されるため、この取り込みを実行中への送信元にすると回答に間に合わない。Pursuit の最終ジョブにも `inference.llm` を使う経路があり、ホストの同資源の枠は1。P2 の画像経路では枠数と Queue キーを維持したまま、画像の完了コミットが作業確認の読み取りと回答入力の間に入ることを確かめる。 [通常の結果取り込み](../eumenes/api/domains/dialogue/service/generation-prepare.ts#L315-L336) · [会話の直列化](../eumenes/api/domains/dialogue/service/intake.ts#L209-L239) · [Queue の競合判定](../eumenes/api/domains/queue/service/runner.ts#L264-L287) · [Pursuit ジョブ](../eumenes/api/domains/pursuit/service/index.ts#L31-L48) · [資源枠](../eumenes/api/application/server-core.ts#L92-L99)
- `checkWork` の成功から `turn.talk(..., { tools: false })` に渡す回答は、既存のモデル呼び出しを一回だけ使う。最初の `chat.complete` の直前で `seal` し、`work-check-answer` を境界 ID として取得する。終了処理と取消で購読と Inbox を閉じる。作業未発見・ホスト定型応答・引き渡しなどで対象の推論へ進まなかった場合も閉じ、理由と未反映件数を記録する。旧世代の保留分は再準備した実行へ移さない。 [Router 後の回答](../eumenes/api/domains/dialogue/service/routed-actions.ts#L143-L153) · [モデル接続](../eumenes/api/domains/dialogue/service/routed-turn.ts#L353-L448) · [終了・取消](../eumenes/api/domains/dialogue/service/generation-handler.ts#L159-L179)

### 回答入力と出典

- 取り込みは `routed-turn` のホスト側 `chat.complete` に限定する。`request.messages` の現在ターン領域にホストの補足を置く。セッションの `instructionCount/historyCount` が示す採用済み履歴の範囲を変えない。既存のチェック結果に同じ成果物 ID が含まれる場合はその文を使う。読み取り後に同じ作業の画像生成が確定した場合は、成果物を再検証し、既存の `resultText` でチェック結果の表示文を更新して一度だけ載せる。文面から ID や版を抽出しない。 [呼び出し単位のセッション情報](../eumenes/api/domains/dialogue/service/routed-turn.ts#L157-L225) · [ホストの notice](../eumenes/api/domains/dialogue/service/routed-turn.ts#L521-L527) · [セッションの分割契約](../eumenes/api/domains/inference/contracts/index.ts#L167-L176)
- 現行の `answerSession` は準備時の記憶ウィンドウを出典にする。追加分はその呼び出しだけの `CallSession.refs` に、既存形式で表現できる `messageIds/itemIds` を和集合で渡す。作業 ID・成果物の版・元発言はホストの実行中スナップショットでも保持し、推論の受理通知で配信・採用の検査対象に加える。現行の `inference_attempts.refs` はクラウドの agent 接続に限って保存されるため、`generationStale` のストリーム検査と writer での回答確定の両方に、使った成果物の版、作業との対応、元発言の検証を加える。出典を失った場合は、既存の abort と回答不採用に接続する。既に配信された文面は配信済みとして扱う。 [現在の refs](../eumenes/api/domains/dialogue/service/generation-stream.ts#L91-L105) · [attempt の保存条件](../eumenes/api/domains/inference/service/attempt-record.ts#L194-L230) · [ストリームの検査](../eumenes/api/domains/dialogue/service/generation-stream.ts#L13-L67) · [回答確定](../eumenes/api/domains/dialogue/service/generation-settle.ts#L135-L179)
- 製品の送信元と受信側が重なるケースは、別の実行で作業結果が確定する時点と、購読側の回答入力確定の間を固定試験で再現する。世代と作業の対応を確認できない結果は既存通知の経路で扱う。通常発言は従来どおり発言と新しい run を作る。明示的な補足送信は §6 で追加する。

## 4. Pursuit の次手判断

1. ホストの Pursuit 行が active になったコミット以降に `id + epoch` を開く。送信が最初なら、コミット済みの行を検証してその場で開ける。Queue の判断ジョブより前の、外部読み取りを待っている間も同じ世代で受け付ける。終了・取消・忘却・修正で旧世代を閉じる。起動直後は Inbox が空で、再開した実行は現在の世代から受け付ける。 [Pursuit 受付と起動](../eumenes/api/domains/pursuit/service/index.ts) · [終了と取消](../eumenes/api/domains/pursuit/service/lifecycle.ts#L15-L92)
2. 送信できる補足は、ホストが対象の `id + epoch` と明示的に対応づけ、既存の SourcePort で解決・検証できる `ExecutionReference` とする。既存の `validReferenceInTransaction/readReferenceInTransaction` を使い、照合した正本の版または digest と同じ情報だけを読む。P2 の固定試験では、対象を指定したホスト入力から有効な資料参照を送る。現行の別ジョブの完了を自動で結びつける経路は追加せず、明示的な対応と失効伝播を持つ製品の送信元から有効化する。 [出典の型](../eumenes/api/domains/tool-runtime/contracts/task-execution.ts#L5-L23) · [Pursuit の公開ポート](../eumenes/api/domains/pursuit/contracts/index.ts#L94-L103) · [ホストの参照検査と読み取り](../eumenes/api/application/toolchain/task-execution-sources.ts#L93-L198)
3. `decision.ts` の `engine.decisionRequest` 後、`model.complete` で現在の判断ジョブと予算を確認してから `operationId` を境界に取得する。決定要求をコアに書き直さず、`packet` に出典付きの参考情報を加え、既存形式に該当する出典を `refs` に合成する。判断後に次の判断があるかはこの時点で確定しないため、各判断では受付を締めず、終端で `close` する。採点・最終検証の packet と予算には追加しない。 [判断要求の取得](../eumenes/api/domains/pursuit/service/decision.ts#L45-L67) · [推論予約と packet](../eumenes/api/domains/pursuit/service/model.ts#L44-L143)
4. 推論中は、使った参照をコミット時に再検証し、失効した場合は当該推論を abort する。判断応答を保存する writer で `current` と同じ出典検証を行い、応答に使った参照は `HostState.steeringReferences?` に、判断応答と同時に登録する。これは判断を通じて後続の計画に影響した出典の記録で、参照自体は既存の `ExecutionReference` と正本を使う。既存の `references` と合わせて32件以内とし、`current` は両方を検証する。再提示は行わず、`amend` では旧判断・計画とともにこの追加分を消す。保存済みの旧形式は空として読む。保存後の `completeDecision` と、後続の操作受付・結果確定が `current` を経由して同じ出典を検証することを P2 で確認する。経由しない区間があれば、その既存の受付・確定点で照合する。これにより判断ジョブと判断を使うジョブの間で失効しても旧結果を採用できない。既存の参照失効時と同じ処理で、実行の停止・忘却を行う。 [判断結果の保存](../eumenes/api/domains/pursuit/service/model.ts#L144-L221) · [判断結果を使うジョブ](../eumenes/api/domains/pursuit/service/jobs.ts#L86-L152) · [現行の権限・参照検査](../eumenes/api/domains/pursuit/service/context.ts#L34-L66)
5. 目標・必須条件の変更は既存の `amend` が扱う。認証された元発言、現在の revision、同じ会話を検証し、子を取り消して `epoch` を進める。期限と使用済み予算は引き継ぐ。保存済み計画を進める区間は Inbox の保留件数に依存させず、操作時点の権限と世代で制御する。即時停止は既存の `cancel` を使う。 [既存の修正・取消契約](../eumenes/api/domains/pursuit/service/control.ts#L20-L87) · [推論なしで進む計画](../eumenes_pursuit/src/domains/loop/productive.ts#L364-L432)

## 5. Agency と Collaboration

### Agency

会話は Eumenes が渡す `chat.complete` を境界にするため、Agency ライブラリの引数や応答ループはそのまま使える。将来 `runRespond` が読み取りツールを実行する経路まで広げる場合は、既存の `tools.call` の戻りから次の `chat.complete` までを使い、モデルが呼んだ回数で境界を識別する。読み取り後の入力には既存の assistant/tool メッセージ列を維持する。`end: true` やツール呼び出しなしでループが終わるときは、保留分を閉じる。 [Eumenes の Agency 接続](../eumenes/api/application/agency/host.ts#L719) · [Agency の応答ループ](../eumenes_agency/src/application/respond.ts#L151-L216)

常時思考には、Eumenes の feed がコミット済み発言・結果を既存の出典とともに渡す。`observe` がユーザー・ツール観測で進めた世代を `tick` が照合し、古い推論結果を採用しない。通常応答の途中へ資料を渡す場合は、常時思考が生成した提案を既存の受領・採用経路で確定し、出典と対象実行の対応が確認できた資料を §3 と同じ受付へ渡す。発話の配送と忘却は既存のホスト契約を使う。 [Eumenes の feed](../eumenes/api/application/agency/always-on-feed.ts) · [観測の世代](../eumenes_agency/src/always-on/agent.ts#L391-L434) · [思考結果の世代照合](../eumenes_agency/src/always-on/agent.ts#L511-L569) · [Eumenes 統合計画](../eumenes/spec/agency-always-on-integration-plan-2026-11-08.md)

### Collaboration

Eumenes には、制作物を保存する `collaboration-adapter.commitInTransaction → works.commit` と、条件・出所を保存する `collaboration-state` の writer がある。P4 はまず送信側を追加する。関係する条件と制作物が確定したコミットの後、明示的に紐づいた実行に `sessionId/epoch`、制作物の ID・版・digest、条件の版・出所の版を正本参照として通知する。複数の writer を経由する場合は、関連する変更が揃った版で送る。同じ版の再読は同じイベント ID にし、単なる状態の再保存からは通知を生成しない。受信側は版を再照合して最新の有効な状態を使う。正式な条件を Pursuit の必須条件として変える操作は §4 の `amend` を通す。 [制作物の保存](../eumenes/api/application/collaboration/collaboration-adapter.ts#L249-L269) · [条件の採用](../eumenes/api/domains/dialogue/service/collaboration-state.ts#L205-L252) · [制作状態の契約](../eumenes_collaboration/spec/host-contract.md)

Collaboration の `proposeStateUpdate` による状態採用と、保護された操作の承認は別の契約を持つ。隣接フォルダの `checkStateApproval` は、ホストが取得した実際の承認証跡を作品版・session・epoch・出所と照合する。Eumenes の現行取り込みには、条件保存と子の起動確認はあるが、この承認チェックの接続は確認できない。P4 で保護された条件を送る前に、対象ホストで正式な承認をどこに保存し、writer のどこで照合するかを確定する。 [承認の検査](../eumenes_collaboration/src/agent/approval.ts#L80) · [子の起動確認](../eumenes/api/domains/collaboration/service/work-children.ts#L35-L78)

受信を追加する場合は、`specialist-turn.runTurn` が各モデル呼び出しの直前に `stateReference` を組み立てる writer を使う。対象は `runId + sessionId + epoch`、境界は既存の call 番号。条件・制作物を動的な参照領域に置き、同じ版を二重提示しない。専門セッションの現行操作は `assertTurnCurrent` と既存の版検査を維持する。先回り支援で背景推論が候補を作る計画は、通常推論への配送を検証した後に、その計画の比較条件に沿って接続する。 [専門ターンの推論境界](../eumenes/api/domains/dialogue/service/specialist-turn.ts#L434-L491) · [先回り支援の実装計画](../eumenes_collaboration/spec/proactive-collaboration-implementation-2026-11-11.md)

## 6. ユーザーからの明示的な補足

P4 では、既存の認証済み会話 API に、現在の run と世代を指定する補足操作を追加する。既存の conversation writer で利用者・会話・対象実行・受付状態を照合し、発言を一件保存する。同じクライアントリクエスト ID は同じ発言 ID に結びつけ、同 ID で本文または対象が異なる場合は衝突とする。受付の確認から保存確定・Inbox 登録まで、入力側の seal とどちらが先かを同じプロセスで確定できる契約を用意する。DB の保存と in-memory 登録は永続化範囲が異なるため、再起動をまたぐ自動配送は行わず、記録された発言を通常履歴から参照できるようにする。

P4 の画面は「受付」「入力へ引き渡し」「受付終了」を区別する。受付終了で発言を保存しなかった場合は入力欄に本文を残して通常送信を選べるようにする。補足操作では回答 run を作らないため、履歴保存が通常発言の未処理イベントや Agency feed を通じて二重の回答・二重の入力を起こさないことを確認する。発言の編集・忘却と権限変更は正本の出典検査へ接続する。 [通常の発言受付と Queue 登録](../eumenes/api/domains/dialogue/service/intake.ts#L164-L239)

## 7. 実装と検証の順序

| 段階 | 作業 | 通過条件 |
| --- | --- | --- |
| P0 基準線 | 隔離コピーと依存のハッシュを固定。`routed-turn.test.ts` の作業確認ケースと `generation-work.test.ts` を会話の基準にし、`routed-work-integration.test.ts` をRouter の判断後に回答用の追加推論がない比較に使う。Pursuit は `pursuit-integration.test.ts` と `productive.test.ts` を使う | 入力内容・推論回数・refs・回答や操作の確定時点を記録。Pursuit の判断、外部読み取り中、保存計画からの操作、終端を区別できる |
| P1 部分 | Inbox を実装し、時刻とイベントの前後関係を固定。`bun run verify`、`bun test --coverage ./test`、`bun run pack:check` | FIFO、取得競合、再送・衝突、再取得の元集合、`unknown`、期限、枠の回復、世代隔離、締切・終了、行カバレッジ80%以上。外部接続のない空の導入先で、試作TGZだけから型検査と受付・取得・確定・終了が通る |
| P2 結合 | 試作 TGZ を隔離コピーに入れ、既存 Queue・writer・Inference に接続。モデルと外部 I/O を固定し、読み取り・入力受理・応答採用の間を試験側の待ち合わせで止める | 両経路のモデル入力へ順序どおり一度だけ届き、refs と出典検査が伝播する。通常経路と推論・回答・操作の回数が一致。refs が attempt に保存されないルートでも失効を防げる |
| P3 通し | `bun run pack:check` で TGZ 単独導入を確認。固定した TGZ を Eumenes の依存に追加し、会話受付から作業確認回答、Pursuit の判断採用と結果確定まで隔離環境で通す | 版・採用元・SHA-256・入力ハッシュ・試験結果が追跡でき、対象ドメイン検証が成功。作業結果の通常通知と切り戻し後の既存経路を確認 |
| P4 追加接続 | 明示補足と Collaboration を独立に有効化し、対象 API と画面・専門セッションを検証 | 明示補足は一発言・同一 run。制作通知は確定した版のみ。承認・出典・作品版の不一致、次の推論を持たない終端、重複送信時の表示を確認 |

P0 の固定試験は [作業確認の回答](../eumenes/api/domains/dialogue/test/routed-turn.test.ts#L179-L204)、[作業結果の既存試験](../eumenes/api/domains/dialogue/test/generation-work.test.ts)、[Router のホスト応答](../eumenes/api/domains/dialogue/test/routed-work-integration.test.ts)、[Pursuit の会話結合](../eumenes/api/application/pursuit/pursuit-integration.test.ts)、[Productive 判断](../eumenes/api/domains/pursuit/test/productive.test.ts) を使用する。

P2 では次の競合を固定して確認する。

- 固定試験で対象実行に結びつけた異なる出典2件が作業の読み取り中に届く。元の読み取りを完了し、回答入力では受付順と出典が対応する。製品の送信元を使う別ケースでは、同じ成果物が元の読み取りにもあれば一度だけ提示する。画像の完了後、通常の作業台帳へ取り込まれる前でも、コミット済みの結果を一度だけ使う。
- 取得直後の到着は同じバッチへ加わらない。最終境界の締切後・旧世代・別会話・過負荷はそれぞれの理由で扱い、次の無関係な run へ移さない。出典の保存がロールバックされた場合は受付が生じない。
- 入力受理前に失敗した場合は再取得できる。受理結果が不明なら別の論理入力へ再注入しない。provider 内部の再試行では凍結した入力と refs が同じ。入力予算超過時は既存推論が補足なしで進む。
- 入力の前、モデル出力の配信中、writer での回答確定直前に出典を失効させる。Pursuit では判断応答を保存した後、次の Queue ジョブが使う前にも失効させ、旧判断を採用せず後続操作を受け付けないことを確認する。保存計画を直接進めるケースでも、`amend` 後に旧世代が結果を確定できないことを確認する。
- 再起動で Inbox が空になり、保存済み履歴・制作条件・Pursuit の目標と受入条件を既存の正本から読み直せる。

P3 の対象ドメイン検証は Eumenes で `bun run verify -- --domain dialogue --domain pursuit --domain conversation --domain memory --domain queue --domain inference --domain live-voice --domain image` を実行する。application 試験が依存解析から漏れる場合は、上記の試験ファイルを明示する。P4 では変更した Collaboration 関連ドメインと対象画面のブラウザー試験を追加する。実モデルと音声実機の受入記録は固定試験と分ける。 [Eumenes の検証手順](../eumenes/docs/verification.md)

構造化ログに残すのは run、境界、固定理由と件数。切り戻しは Inbox の送受信の接続とパッケージ依存を外す。正式な発言、作業結果、制作条件の保存は引き続き既存経路を使う。初回の作業単位は P0 の基準線と、両ホスト経路の出典失効を実際に止められることの確認。公開 API は P2 の結果で確定する。 [配布と切り戻し](plan.md#6-実施順序と完了条件)
