# Podcast Generate CLI

テキストファイルから音声を生成するコマンドラインツールです。永続的なDockerコンテナで動作するローカルの[VOICEVOX Engine](https://voicevox.hiroshiba.jp/)を使用します。

## 機能

- **ローカル処理**: すべての音声生成はローカルで行われます。
- **明示的なコンテナ管理**: VOICEVOXエンジンコンテナのライフサイクルを完全に制御できます。
- **効率的**: 永続的なコンテナを使用するため、毎回再作成する必要がなく、素早く起動・停止できます。
- **自動テキスト分割**: 長いテキストは約600文字で自動的に分割され、文の境界（「。」）で区切られるため、メモリ問題を防ぎます。
- **並列処理**: 複数のテキストチャンクを並列で処理するため、生成が高速化されます。
- **自動音声結合**: 生成されたすべての音声チャンクが自動的に1つのWAVファイルに結合されます。

## 前提条件

- **Node.js**: v16以降を推奨。
- **Docker**: Docker DesktopまたはDocker Engineがインストールされ、システムで実行されている必要があります。
- **FFmpeg**: MP3形式で出力する場合、FFmpegがシステムにインストールされている必要があります（WAV形式のみの場合は不要）。
- **システムリソース**: 
  - **メモリ**: VOICEVOXエンジンはデフォルトでworker5を使用し、処理中に最大**16GBのRAM**を消費する可能性があります。Dockerに十分なメモリが割り当てられていることを確認してください。
  - **CPU**: 音声合成はCPU上で動作する深層学習モデルを使用するため、計算集約的な処理です。処理時間はテキストの長さとシステムのパフォーマンスによって大きく異なります。
  - **発熱**: CPUを長時間フル稼働させるため、**システムがかなり発熱します**。特に長時間の処理中は、適切な冷却と換気を確保してください。

## 1. インストール

リポジトリをクローンし、必要な依存関係をインストールします。

```bash
npm install
```

## 2. ワークフロー

このツールは、永続的な名前付きDockerコンテナ（`podcast-generate-voicevox-engine`）を使用してVOICEVOXエンジンを実行します。ワークフローは明示的で予測可能に設計されています。

### ステップ1: 初回セットアップ

初めてツールを使用する際は、コンテナを作成する必要があります。`generate`コマンドが案内します。

```bash
# ファイル生成を試みる
npx ts-node src/cli.ts generate -t texts/intro.txt -o audio/out.wav -c 1
```

コンテナがまだ存在しない場合、次のようなメッセージが表示されます：

```
Container 'podcast-generate-voicevox-engine' does not exist. Creating it for first-time use...
(Docker pull output...)
Error:
----------------------------------------------------------------------------------
Container 'podcast-generate-voicevox-engine' has been created.
Before you can generate audio, you need to start it.

Please run: npx ts-node src/cli.ts docker start

Then, re-run your previous command.
----------------------------------------------------------------------------------
```
この初回セットアップにより、コンテナが使用可能になります。

### ステップ2: 音声生成

指示に従って、コンテナを起動してから`generate`コマンドを再度実行します。

```bash
# 1. エンジンを起動
npx ts-node src/cli.ts docker start

# 2. generate/list-charactersコマンドを実行
npx ts-node src/cli.ts generate -t texts/intro.txt -o audio/out.wav -c 1
npx ts-node src/cli.ts list-characters
```
コンテナが既に起動している場合、`generate`と`list-characters`コマンドはすぐに動作します。停止している場合、自動的に起動されます。

### ステップ3: エンジンの停止

作業が完了したら、コンテナを停止してシステムリソースを解放できます。

```bash
npx ts-node src/cli.ts docker stop
```
コンテナは停止されますが、削除されません。次のセッションで素早く再起動できます。

## コマンド

### `generate`
テキストファイルから音声ファイルを生成します。
- エンジンコンテナが停止している場合、自動的に起動されます（約10秒かかります）。
- エンジンコンテナが作成されていない場合、作成を促すメッセージが表示されます。
- **自動テキスト分割**: 長いテキスト（600文字を超える場合）は、メモリ問題を防ぐために、文の境界（「。」）で自動的に小さなチャンクに分割されます。各チャンクが処理され、1つの出力ファイルに結合されます。
- **並列処理**: すべてのテキストチャンクが並列で処理されるため、生成が高速化されます。
- **文字数制限**: 入力テキストファイルの最大文字数は**10万文字**です。これを超える場合はエラーになります。

**パフォーマンスに関する注意:**
- 音声合成はCPU上で動作する深層学習モデルを使用するため、計算集約的な処理です。
- 処理時間はテキストの長さとシステムのパフォーマンスによって大きく異なります：
  - 短いテキスト（約100文字）: 約5-10秒
  - 中程度のテキスト（約500文字）: 約20-40秒
  - 長いテキスト（約2000文字、チャンクに分割）: 約1-3分
- エンジンはデフォルトでworker5を使用し、処理中に最大**16GBのRAM**を消費する可能性があります。
- **タイムアウト**: 各音声合成リクエストのタイムアウトは**60分**に設定されています。非常に長いテキストの処理には時間がかかる場合があります。
- **発熱**: CPUを長時間フル稼働させるため、システムがかなり発熱します。特に長時間の処理中は、適切な冷却と換気を確保してください。
- メモリエラーが発生したり、コンテナがクラッシュする場合は、以下を試してください：
  1. **Docker worker数を削減**: コンテナ作成時に環境変数を設定して、より少ないworker数（例：worker5の代わりにworker3）を使用するようにコンテナを変更します。
  2. **Dockerメモリ上限を増やす**: Docker Desktopで、Settings → Resources → Memoryに移動し、割り当てメモリを増やします（推奨：少なくとも8GB、できれば16GB以上）。

**オプション:**
- `-t, --text-file`: 入力テキストファイルのパス（必須）
- `-o, --output-file`: 出力音声ファイルを保存するパス（必須）。拡張子が`.mp3`の場合はMP3形式、`.wav`の場合はWAV形式で出力されます。。拡張子が`.mp3`の場合はMP3形式、`.wav`の場合はWAV形式で出力されます。
- `-c, --character-id`: キャラクター（話者）のID（必須）
- `--pitch`: 声のピッチ（デフォルト: 0）
- `--intonation-scale`: 声の抑揚スケール（デフォルト: 1）
- `--speed`: 声の速度（デフォルト: 1）

```bash
npx ts-node src/cli.ts generate -t <text-file> -o <output-file> -c <character-id>
```

**オプション付きの例:**
```bash
# WAV形式で出力
npx ts-node src/cli.ts generate -t texts/example.txt -o audio/out.wav -c 1 --pitch 0 --speed 1.2

# MP3形式で出力（ファイルサイズが小さくなります）
npx ts-node src/cli.ts generate -t texts/example.txt -o audio/out.mp3 -c 1 --pitch 0 --speed 1.2
```

### `list-characters`
エンジンから利用可能なすべてのキャラクターを一覧表示します。
- `generate`と同じコンテナ起動/作成ロジックに従います。

```bash
npx ts-node src/cli.ts list-characters
```

### `docker <action>`
VOICEVOXエンジンコンテナを完全に制御します。

| アクション | 説明                                                                  |
| -------- | ---------------------------------------------------------------------------- |
| `status` | Dockerとエンジンコンテナのステータスを確認します。                        |
| `pull`   | Docker Hubから最新の`voicevox/voicevox_engine`イメージを手動でプルします。  |
| `create` | 永続的なコンテナを作成します（まだ存在しない場合）。              |
| `start`  | 停止したコンテナを起動します。                                                |
| `stop`   | 実行中のコンテナを停止します（削除しません）。                             |
| `delete` | コンテナを**完全に削除**します。再度`create`する必要があります。   |

**例:**
```bash
# ステータスを確認
npx ts-node src/cli.ts docker status

# コンテナを停止
npx ts-node src/cli.ts docker stop

# コンテナを削除して再作成
npx ts-node src/cli.ts docker delete
npx ts-node src/cli.ts docker create
```
