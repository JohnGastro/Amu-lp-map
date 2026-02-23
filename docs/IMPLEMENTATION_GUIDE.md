# Rover Dashboard - 実装ガイド

「Step 3 Frame」から生成されたRover Dashboardの実装方法を説明します。

## 📦 生成されたファイル

1. **rover-dashboard.html** - スタンドアロン版HTMLファイル
2. **webflow-embed.html** - Webflow埋め込み用コード

## 🎨 デザインの特徴

- **ダークテーマ**: モダンで洗練されたダークUI
- **レスポンシブ対応**: 様々な画面サイズに対応
- **Tailwind CSS**: CDN経由で読み込み（カスタマイズ不要）
- **Material Symbols**: アイコンフォント使用
- **カスタムフォント**: JetBrains Mono（モノスペース）+ Geist（サンセリフ）

## 🚀 Webflowでの実装方法

### ステップ1: フォントの読み込み

Webflowプロジェクトの **Project Settings > Custom Code > Head Code** に以下を追加:

```html
<!-- Google Fonts -->
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&display=swap" rel="stylesheet">

<!-- Material Symbols (Icons) -->
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Sharp:wght@100&display=swap" rel="stylesheet">
```

### ステップ2: Embedコードの追加

1. Webflowエディタで **Embed要素** を追加
2. `webflow-embed.html` の内容をコピー
3. Embed要素にペースト
4. Publishして確認

### ステップ3: サイズ調整（必要に応じて）

Embed要素の高さを調整:
- デフォルト: 900px
- フルスクリーン: 100vh

## 📐 レイアウト構造

```
┌─────────────────────────────────────────┐
│  Sidebar (280px)  │  Main Content      │
│  ┌──────────────┐ │  ┌──────────────┐  │
│  │ Logo         │ │  │ Header       │  │
│  ├──────────────┤ │  ├──────────────┤  │
│  │ Navigation   │ │  │ Stats (4)    │  │
│  │ - Dashboard  │ │  ├──────────────┤  │
│  │ - Fleet      │ │  │ Data Table   │  │
│  │ - Bookings   │ │  │ - 6 rows     │  │
│  │ - Missions   │ │  │ - Pagination │  │
│  │ - Maintenance│ │  └──────────────┘  │
│  │ - Analytics  │ │                     │
│  │ - Settings   │ │                     │
│  ├──────────────┤ │                     │
│  │ User Profile │ │                     │
│  └──────────────┘ │                     │
└─────────────────────────────────────────┘
```

## 🎯 主要コンポーネント

### 1. サイドバー
- ロゴ（SVG）
- ナビゲーションメニュー（アクティブ状態あり）
- ユーザープロフィール

### 2. ヘッダー
- ページタイトルと説明
- アクションボタン（Search Rovers, Add Rover）

### 3. 統計カード（4枚）
- Total Rovers: 24 (+3 this month)
- Available Now: 18 (75% fleet)
- Active Rentals: 6 (on mission)
- Revenue: $48.2K (+12.5%)

### 4. データテーブル
- 検索とエクスポート機能
- 6件のRover情報
- ステータスバッジ（Available, On Mission, Maintenance）
- アクションボタン（Rent, View）
- ページネーション

## 🎨 カラーパレット（ダークテーマ）

```css
--background: #111111      /* メインの背景 */
--foreground: #FFFFFF      /* メインのテキスト */
--card: #1A1A1A           /* カードの背景 */
--primary: #FF8400        /* プライマリカラー（オレンジ） */
--sidebar: #18181b        /* サイドバーの背景 */
--muted-foreground: #B8B9B6  /* 控えめなテキスト */
--border: #2E2E2E         /* ボーダー */
```

## ⚙️ カスタマイズ方法

### 色の変更
CSS変数を編集してカラースキームを変更できます:

```css
.rover-dashboard {
  --primary: #FF8400;  /* お好みの色に変更 */
}
```

### テーブルデータの変更
`<tbody>` 内の `<tr>` 要素を編集してデータを変更:

```html
<tr>
  <td><strong>新しいRover名</strong></td>
  <td style="color: var(--muted-fg);">モデル名</td>
  ...
</tr>
```

### ナビゲーション項目の追加
サイドバーに新しい項目を追加:

```html
<div class="nav-item">
  <span class="material-icons">アイコン名</span>
  <span>メニュー名</span>
</div>
```

## 🔧 トラブルシューティング

### フォントが表示されない
- Google Fontsのリンクが正しく読み込まれているか確認
- ブラウザのキャッシュをクリア

### アイコンが表示されない
- Material Symbolsのリンクが読み込まれているか確認
- アイコン名が正しいか確認（[Material Symbols](https://fonts.google.com/icons)で検索）

### レイアウトが崩れる
- Embed要素のサイズが十分か確認（最小: 1440px x 900px）
- ブラウザの互換性を確認（Chrome, Firefox, Safari推奨）

## 📱 レスポンシブ対応

現在の実装は1440px幅を想定していますが、以下のブレークポイントを追加してレスポンシブ対応できます:

```css
@media (max-width: 1024px) {
  .sidebar {
    width: 240px;
  }
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .dashboard-container {
    flex-direction: column;
  }
  .sidebar {
    width: 100%;
    height: auto;
  }
}
```

## 🌐 ブラウザ対応

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 📝 ライセンス

このコードは自由に使用、カスタマイズ、配布できます。

## 🆘 サポート

質問や問題がある場合は、プロジェクトのIssueトラッカーで報告してください。
