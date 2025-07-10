# Cloudflare Worker Google Drive Index & Tools

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个功能强大的 Cloudflare Worker 项目，可以将您的 Google Drive 文件夹变成一个精美的、支持多端适配的文件浏览器。同时，它还集成了通用代理下载和文件转存等高级工具。

## ✨ 功能特性

-   **文件浏览器**：以可视化界面的形式，只读浏览指定的 Google Drive 文件夹。
-   **响应式设计**：完美适配桌面和移动设备。
-   **流式代理下载**：所有文件均通过 Worker 进行流式代理，支持大文件下载，不占用 Worker 大量内存。
-   **多线程下载支持**：完美兼容 IDM、Aria2 等多线程下载器，支持断点续传。
-   **直链生成**：为列表中的每个文件生成可直接下载的代理链接，并提供一键复制功能。
-   **通用链接下载器**：不仅支持 Google Drive 链接，还可以代理任何文件的直接下载链接。
-   **云端转存**：将他人分享的 Google Drive 文件或文件夹，一键完整复制到您自己的云盘中。

---

## 🚀 部署指南

### 第 1 步：获取 Google API 凭证

1.  访问 [Google Cloud Console](https://console.cloud.google.com/) 并创建一个新项目。
2.  在项目中启用 **Google Drive API**。
3.  配置 **OAuth 同意屏幕**：
    -   用户类型选择“外部”。
    -   应用名称、用户支持电子邮箱必填。
    -   在“已获授权的网域”中，添加 `developers.google.com`。
    -   将应用发布状态设为“**正式版**”，以确保 Refresh Token 长期有效。
4.  创建 **OAuth 2.0 客户端 ID**：
    -   应用类型选择“Web 应用”。
    -   在“已获授权的重定向 URI”中，添加 `https://developers.google.com/oauthplayground`。
    -   创建后，您将获得 `CLIENT_ID` 和 `CLIENT_SECRET`。

### 第 2 步：获取 Refresh Token

1.  访问 [Google OAuth Playground](https://developers.google.com/oauthplayground)。
2.  点击右上角齿轮⚙️，勾选 "Use your own OAuth credentials"，并输入您的 `CLIENT_ID` 和 `CLIENT_SECRET`。
3.  在左侧的 API 列表中，找到 Drive API v3，并勾选 **最高权限** 的 `https://www.googleapis.com/auth/drive`。
4.  点击 "Authorize APIs"，用您的 Google 账户登录并授权。
5.  授权成功后，点击 "Exchange authorization code for tokens"。
6.  复制并**妥善保管**右侧生成的 `Refresh token`，它只会显示一次。

### 第 3 步：获取 Google Drive 根文件夹 ID

-   在浏览器中打开您想分享的 Google Drive 文件夹，地址栏 URL 的最后一部分就是文件夹 ID。
-   例如: `https://drive.google.com/drive/folders/THIS_IS_THE_ID`
-   如果要分享整个云盘，可以使用 `root`。

### 第 4 步：部署到 Cloudflare Workers

1.  登录 Cloudflare，创建并部署一个新的 Worker。
2.  将本仓库的 `index.js` 文件内容完整复制到 Worker 编辑器中。
3.  进入 Worker 的 "设置" -> "变量" 页面，添加以下 **4 个机密变量**：
    -   `CLIENT_ID`: 您的客户端 ID。
    -   `CLIENT_SECRET`: 您的客户端密钥。
    -   `REFRESH_TOKEN`: 您获取的**拥有完整权限**的刷新令牌。
    -   `ROOT_FOLDER_ID`: 您要分享的文件夹 ID。
4.  点击“保存并部署”。

---

## ⚠️ 重要注意事项

-   **多线程下载限制**：Google Drive 对它无法进行病毒扫描的文件类型 (如 `.asar`, 加密压缩包等) 会**强制禁用多线程下载**。这是服务器端的安全策略。**最佳解决方案：** 将这类文件压缩成普通的 `.zip` 格式再分享或下载。
-   **转存后立即下载**：使用“转存”功能后，Google Drive 后台需要时间处理新文件的元数据。在此期间立即下载该文件，可能导致无法多线程。本工具已内置等待机制，但若遇到问题，请**稍等一两分钟再试**。
-   **文件夹转存限制**：转存大型或层级很深的文件夹可能会因超出 Cloudflare Worker 的 **30秒执行时间限制**而失败。此功能最适合中小型文件夹。
-   **API 权限**：“转存”功能要求 Refresh Token 必须拥有完整的 `.../auth/drive` 权限。
-   **浏览器缓存**：修改代码后若功能未更新，请**强制刷新 (Ctrl+F5)** 或使用**无痕模式**测试。

## 📄 许可证

本项目采用 [MIT License](./LICENSE) 开源。