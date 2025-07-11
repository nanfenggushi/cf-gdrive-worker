// =================================================================
// Cloudflare Worker: GDrive Browser, Proxy Downloader & Copier
// Author: AI Assistant
// Version: 7.2 (Mobile UI Fix for Notes)
// Features: GDrive Browser, Universal Proxy, GDrive Copier, Multi-threaded Downloads, Copy Metadata Polling, Range Support Detection, UI Notes with Mobile Fix
// =================================================================

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};

const config = { auth: {}, root_folder_id: '' };

async function handleRequest(request, env) {
    config.auth.client_id = env.CLIENT_ID;
    config.auth.client_secret = env.CLIENT_SECRET;
    config.auth.refresh_token = env.REFRESH_TOKEN;
    config.root_folder_id = env.ROOT_FOLDER_ID;

    if (!config.auth.client_id || !config.auth.client_secret || !config.auth.refresh_token || !config.root_folder_id) {
        return new Response("环境变量未完整配置！", { status: 500 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    if (path === '/') return serveUI();
    if (path.startsWith('/api/list/')) {
        const folderId = path.substring('/api/list/'.length) || config.root_folder_id;
        return listFiles(folderId);
    }
    if (path.startsWith('/api/download/')) {
        const fileId = path.substring('/api/download/'.length);
        const fileName = params.get('name');
        return downloadFile(request, fileId, fileName);
    }
    if (path.startsWith('/api/generate-link')) {
        const driveLink = params.get('url');
        return generateDirectLink(driveLink);
    }
    if (path.startsWith('/api/proxy')) {
        const targetUrl = params.get('url');
        return proxyRequest(request, targetUrl);
    }
    if (path.startsWith('/api/copy')) {
        const shareLink = params.get('url');
        return copyToDrive(shareLink);
    }

    return new Response('路径无效', { status: 404 });
}


// --- API 实现 ---

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: config.auth.client_id,
            client_secret: config.auth.client_secret,
            refresh_token: config.auth.refresh_token,
            grant_type: 'refresh_token',
        }),
    });
    const data = await response.json();
    if (data.error) throw new Error(`获取 Access Token 失败: ${data.error_description || data.error}`);
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

async function downloadFile(request, fileId, fileName) {
    try {
        const token = await getAccessToken();
        const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType`;
        const metaRes = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!metaRes.ok) throw new Error(`获取文件元数据失败: ${metaRes.status} ${await metaRes.text()}`);
        const metadata = await metaRes.json();
        const fileSize = parseInt(metadata.size, 10);

        const range = request.headers.get('range');
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

        const headers = new Headers();
        headers.set('Authorization', `Bearer ${token}`);
        if (range) {
            headers.set('Range', range);
        }

        const driveResponse = await fetch(downloadUrl, { method: 'GET', headers: headers });
        if (!driveResponse.ok) throw new Error(`从 Google Drive 下载失败: ${driveResponse.status} ${await driveResponse.text()}`);

        const responseHeaders = new Headers();
        const isRangeSupported = driveResponse.status === 206;

        if (isRangeSupported) {
            responseHeaders.set('Content-Range', driveResponse.headers.get('Content-Range'));
            responseHeaders.set('Content-Length', driveResponse.headers.get('Content-Length'));
        } else {
            responseHeaders.set('Content-Length', String(fileSize));
        }

        if (isRangeSupported) {
            responseHeaders.set('Accept-Ranges', 'bytes');
        }

        responseHeaders.set('Content-Type', metadata.mimeType || 'application/octet-stream');
        if (fileName) {
            responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        }
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Expose-Headers', '*');

        return new Response(driveResponse.body, {
            status: driveResponse.status,
            statusText: driveResponse.statusText,
            headers: responseHeaders
        });

    } catch (error) {
        console.error("下载文件时出错:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

async function copyToDrive(shareLink) {
    if (!shareLink) return new Response(JSON.stringify({ error: "缺少 'url' 参数" }), { status: 400 });
    const fileId = extractFileIdFromUrl(shareLink);
    if (!fileId) return new Response(JSON.stringify({ error: "无法从链接中解析出文件/文件夹 ID" }), { status: 400 });

    try {
        const token = await getAccessToken();
        const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,name`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!metaResponse.ok) throw new Error(`获取元数据失败: ${(await metaResponse.json()).error.message}`);
        const metadata = await metaResponse.json();

        if (metadata.mimeType === 'application/vnd.google-apps.folder') {
            await copyFolderRecursive(fileId, config.root_folder_id, token);
            return new Response(JSON.stringify({ message: `文件夹 "${metadata.name}" 已开始转存。请稍后在目标目录查看。` }), { headers: { 'Content-Type': 'application/json' } });
        } else {
            const copyResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ parents: [config.root_folder_id] })
            });
            if (!copyResponse.ok) throw new Error(`复制文件失败: ${(await copyResponse.json()).error.message}`);
            const newFileInfo = await copyResponse.json();
            const newFileId = newFileInfo.id;

            let attempts = 0;
            const maxAttempts = 15;
            while (attempts < maxAttempts) {
                const checkMetaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${newFileId}?fields=size`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (checkMetaRes.ok) {
                    const checkMetadata = await checkMetaRes.json();
                    if (checkMetadata.size != null) {
                        return new Response(JSON.stringify({ message: `文件 "${metadata.name}" 已成功转存，元数据已就绪！` }), { headers: { 'Content-Type': 'application/json' } });
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 1500));
                attempts++;
            }
            return new Response(JSON.stringify({ message: `文件 "${metadata.name}" 已转存，但元数据仍在处理中，可能影响立即下载。` }), { headers: { 'Content-Type': 'application/json' } });
        }
    } catch (error) {
        console.error("转存时出错:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

async function copyFolderRecursive(sourceFolderId, destinationParentId, token) {
    const sourceFolderMeta = await (await fetch(`https://www.googleapis.com/drive/v3/files/${sourceFolderId}?fields=name`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
    const createFolderResponse = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sourceFolderMeta.name, mimeType: 'application/vnd.google-apps.folder', parents: [destinationParentId] }) });
    const newFolderId = (await createFolderResponse.json()).id;
    let pageToken = null;
    do {
        const listUrl = `https://www.googleapis.com/drive/v3/files?q='${sourceFolderId}' in parents and trashed=false&fields=nextPageToken,files(id,mimeType)&pageToken=${pageToken || ''}`;
        const listData = await (await fetch(listUrl, { headers: { 'Authorization': `Bearer ${token}` } })).json();
        for (const item of listData.files) {
            if (item.mimeType === 'application/vnd.google-apps.folder') {
                await copyFolderRecursive(item.id, newFolderId, token);
            } else {
                await fetch(`https://www.googleapis.com/drive/v3/files/${item.id}/copy`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ parents: [newFolderId] }) });
            }
        }
        pageToken = listData.nextPageToken;
    } while (pageToken);
}

async function listFiles(folderId) {
    try {
        const token = await getAccessToken();
        let query = `'${folderId}' in parents and trashed=false`;
        const fileFields = "id, name, mimeType, size, modifiedTime";
        const filesResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(${fileFields})&orderBy=folder,name&pageSize=1000`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!filesResponse.ok) throw new Error(`Google Drive API (list) 错误: ${filesResponse.status} ${await filesResponse.text()}`);
        const filesData = await filesResponse.json();
        const files = filesData.files || [];
        let breadcrumbs = [{ id: config.root_folder_id, name: "首页" }];
        if (folderId && folderId !== config.root_folder_id) {
            let currentId = folderId, safetyCounter = 0;
            while (currentId && currentId !== config.root_folder_id && safetyCounter < 10) {
                const folderInfoResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${currentId}?fields=id,name,parents`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!folderInfoResponse.ok) break;
                const folderInfo = await folderInfoResponse.json();
                breadcrumbs.splice(1, 0, { id: folderInfo.id, name: folderInfo.name });
                currentId = folderInfo.parents ? folderInfo.parents[0] : null;
                safetyCounter++;
            }
        }
        return new Response(JSON.stringify({ files, breadcrumbs }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

async function generateDirectLink(driveLink) {
    const fileId = extractFileIdFromUrl(driveLink);
    if (!fileId) return new Response(JSON.stringify({ error: "无法解析文件ID" }), { status: 400 });
    const token = await getAccessToken();
    const fileInfo = await (await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
    const proxyLink = `/api/download/${fileId}?name=${encodeURIComponent(fileInfo.name || 'download')}`;
    return new Response(JSON.stringify({ fileName: fileInfo.name, proxyLink }), { headers: { 'Content-Type': 'application/json' } });
}

async function proxyRequest(request, targetUrl) {
    if (!targetUrl) return new Response('缺少 "url" 参数', { status: 400 });
    const headers = new Headers(request.headers);
    headers.delete('Host');
    const response = await fetch(targetUrl, { method: request.method, headers, redirect: 'follow' });
    const responseHeaders = new Headers(response.headers);
    const filename = new URL(targetUrl).pathname.split('/').pop() || 'download';
    responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Expose-Headers', '*');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function extractFileIdFromUrl(url) {
    const patterns = [/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/, /drive\.google\.com\/uc\?id=([a-zA-Z0-9_-]+)/, /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/, /drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function serveUI() {
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件浏览器与工具箱</title>
    <style>
        :root { --primary-color: #4a90e2; --secondary-color: #f5f7fa; --text-color: #333; --border-color: #e0e0e0; --hover-bg-color: #e9f2fd; --card-bg: #ffffff; --shadow: 0 2px 4px rgba(0,0,0,0.1); }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; background-color: var(--secondary-color); color: var(--text-color); line-height: 1.6; }
        .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
        header h1 { color: var(--primary-color); text-align: center; margin-bottom: 20px; }
        .card { background-color: var(--card-bg); border-radius: 8px; box-shadow: var(--shadow); padding: 20px; margin-bottom: 20px; }
        .card h3 { margin-top:0; }
        .tool-container { display: flex; flex-wrap: wrap; align-items: center; }
        .tool-container input { flex-grow: 1; padding: 10px; border: 1px solid var(--border-color); border-radius: 5px; margin-right: 10px; font-size: 14px; min-width: 200px; }
        .tool-container button { padding: 10px 15px; }
        #breadcrumb { display: flex; flex-wrap: wrap; padding: 10px 0; margin-bottom: 20px; align-items: center; }
        #breadcrumb a { color: var(--primary-color); text-decoration: none; font-size: 16px; }
        #breadcrumb a:hover { text-decoration: underline; }
        #breadcrumb span { margin: 0 8px; color: #999; }
        #file-list { list-style: none; padding: 0; }
        .file-item { display: flex; align-items: center; padding: 12px 15px; border-bottom: 1px solid var(--border-color); }
        .file-item:hover { background-color: var(--hover-bg-color); }
        .file-icon { width: 32px; height: 32px; margin-right: 15px; flex-shrink: 0; }
        .file-info { flex-grow: 1; overflow: hidden; }
        .file-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #000; }
        .file-name.folder { color: var(--primary-color); cursor: pointer; }
        .file-meta { font-size: 12px; color: #777; margin-top: 4px; }
        .file-actions { display: flex; align-items: center; flex-shrink: 0; margin-left: 15px; }
        .action-btn { background-color: var(--primary-color); color: white; border: none; border-radius: 5px; padding: 6px 12px; font-size: 13px; cursor: pointer; margin-left: 8px; white-space: nowrap; transition: background-color 0.2s; }
        .action-btn:hover { background-color: #357abd; }
        .copy-btn { background-color: #5cb85c; }
        .copy-btn:hover { background-color: #4cae4c; }
        .status-text { font-size: 14px; margin-top: 10px; word-break: break-word; }
        .status-text.success { color: #28a745; }
        .status-text.error { color: #dc3545; }
        
        /* 注意事项样式 */
        .notes-section details { border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 15px; }
        .notes-section summary { font-weight: bold; cursor: pointer; color: var(--primary-color); }
        .notes-section ul { padding-left: 20px; margin-top: 10px; }
        .notes-section li { margin-bottom: 8px; }
        .notes-section code {
            background-color: #eef;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
            word-break: break-all; /* 强制长文本换行 */
        }
        .notes-section strong { color: #d9534f; }

        /* 手机端适配 */
        @media (max-width: 600px) {
            .notes-section ul {
                padding-left: 15px; /* 减小手机上的列表缩进 */
            }
            .notes-section li {
                font-size: 14px; /* 调整字体大小以便阅读 */
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header><h1>Google Drive 工具箱</h1></header>
        <div class="card notes-section">
            <details>
                <summary>点击展开/折叠 - 重要注意事项</summary>
                <ul>
                    <li><strong>多线程下载限制：</strong> Google Drive 对它无法进行病毒扫描的文件类型 (如未知的压缩包格式 <code>.asar</code>, 加密压缩包, 大型可执行文件等) 会<strong>强制禁用多线程下载</strong>。这是服务器端的安全策略，无法通过本工具绕过。<strong>最佳解决方案：</strong>将这类文件压缩成普通的 <code>.zip</code> 格式再进行转存或下载。</li>
                    <li><strong>转存后立即下载问题：</strong> 使用“转存”功能复制一个新文件后，Google Drive 后台需要一些时间 (从几秒到几十秒不等) 来处理并生成完整的元数据 (尤其是文件大小 <code>size</code>)。在此期间立即下载该文件，可能会因为无法获取到文件总大小而导致下载工具无法多线程下载。本工具已内置等待机制，但若遇到问题，请<strong>稍等一两分钟再尝试下载</strong>。</li>
                    <li><strong>文件夹转存限制：</strong> “转存”功能可以复制整个文件夹，但对于包含大量文件或层级很深的文件夹，可能会因为处理时间过长而超出 Cloudflare Worker 的 <strong>30秒执行时间限制</strong>，导致转存不完整或失败。此功能最适合中小型文件夹。</li>
                    <li><strong>API 权限：</strong> “转存”功能要求您在获取 <code>REFRESH_TOKEN</code> 时，必须授予完整的 <code>https://www.googleapis.com/auth/drive</code> 权限，而不仅仅是只读权限。如果转存失败并提示权限不足，请按文档重新生成令牌。</li>
                    <li><strong>浏览器缓存：</strong> 如果您修改了 Worker 代码但发现功能没有变化，这很可能是浏览器缓存了旧的脚本。请尝试<strong>强制刷新 (Ctrl+F5)</strong> 或在<strong>无痕模式</strong>下访问。</li>
                </ul>
            </details>
        </div>
        <div class="card">
            <h3>转存到云端硬盘</h3>
            <p>粘贴 Google Drive 分享链接，文件/文件夹将被复制到您指定的根目录中。</p>
            <div class="tool-container">
                <input type="text" id="copy-link-input" placeholder="https://drive.google.com/...">
                <button class="action-btn" id="copy-btn">开始转存</button>
            </div>
            <p id="copy-status" class="status-text"></p>
        </div>
        <div class="card">
            <h3>通用链接下载器</h3>
            <p>粘贴任何文件下载链接 (包括 Google Drive)，生成代理下载链接。</p>
            <div class="tool-container">
                <input type="text" id="generate-link-input" placeholder="https://... 或 https://drive.google.com/file/d/...">
                <button class="action-btn" id="generate-link-btn">生成</button>
            </div>
            <div id="link-result-container" style="display:none; margin-top: 15px;">
                <p><strong>文件名:</strong> <span id="result-filename"></span></p>
                <p style="word-break:break-all;"><strong>代理链接:</strong> <code id="result-proxy-link"></code></p>
                <div class="file-actions" style="margin-left: 0; margin-top: 10px;">
                    <button class="action-btn" id="result-download-btn">下载</button>
                    <button class="action-btn copy-btn" id="result-copy-btn">复制链接</button>
                </div>
            </div>
            <p id="link-error" class="status-text error"></p>
        </div>
        <div class="card">
            <div id="breadcrumb"></div>
            <ul id="file-list"></ul>
            <div id="loader" style="text-align:center; padding: 40px;">正在加载...</div>
        </div>
    </div>
    <script>
        // --- DOM Elements ---
        const copyBtn = document.getElementById('copy-btn');
        const copyLinkInput = document.getElementById('copy-link-input');
        const copyStatus = document.getElementById('copy-status');
        const generateBtn = document.getElementById('generate-link-btn');
        const generateLinkInput = document.getElementById('generate-link-input');
        const linkResultContainer = document.getElementById('link-result-container');
        const resultFilename = document.getElementById('result-filename');
        const resultProxyLink = document.getElementById('result-proxy-link');
        const resultDownloadBtn = document.getElementById('result-download-btn');
        const resultCopyBtn = document.getElementById('result-copy-btn');
        const linkError = document.getElementById('link-error');
        const fileListEl = document.getElementById('file-list');
        const loaderEl = document.getElementById('loader');
        const breadcrumbEl = document.getElementById('breadcrumb');
        const rootFolderId = "${config.root_folder_id}";

        // --- Event Listeners ---
        copyBtn.addEventListener('click', async () => {
            const url = copyLinkInput.value.trim();
            if (!url) {
                alert('请输入 Google Drive 分享链接');
                return;
            }
            copyStatus.textContent = '正在处理，请稍候... (大文件夹可能需要较长时间)';
            copyStatus.className = 'status-text';
            copyBtn.disabled = true;
            try {
                const response = await fetch(\`/api/copy?url=\${encodeURIComponent(url)}\`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '未知错误');
                copyStatus.textContent = data.message;
                copyStatus.className = 'status-text success';
            } catch (error) {
                copyStatus.textContent = '错误: ' + error.message;
                copyStatus.className = 'status-text error';
            } finally {
                copyBtn.disabled = false;
            }
        });

        generateBtn.addEventListener('click', async () => {
            const url = generateLinkInput.value.trim();
            if (!url) {
                alert('请输入下载链接');
                return;
            }
            generateBtn.textContent = '...';
            generateBtn.disabled = true;
            linkResultContainer.style.display = 'none';
            linkError.textContent = '';
            try {
                let proxyLink, fileName;
                const isGoogleDrive = /drive\\.google\\.com/.test(url);
                if (isGoogleDrive) {
                    const response = await fetch(\`/api/generate-link?url=\${encodeURIComponent(url)}\`);
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error);
                    proxyLink = data.proxyLink;
                    fileName = data.fileName;
                } else {
                    fileName = new URL(url).pathname.split('/').pop() || 'download';
                    proxyLink = \`/api/proxy?url=\${encodeURIComponent(url)}\`;
                }
                const fullProxyUrl = window.location.origin + proxyLink;
                resultFilename.textContent = fileName;
                resultProxyLink.textContent = fullProxyUrl;
                resultDownloadBtn.onclick = () => { window.location.href = proxyLink; };
                resultCopyBtn.onclick = () => copyToClipboard(fullProxyUrl, resultCopyBtn);
                linkResultContainer.style.display = 'block';
            } catch (error) {
                linkError.textContent = '错误: ' + error.message;
            } finally {
                generateBtn.textContent = '生成';
                generateBtn.disabled = false;
            }
        });

        // --- Helper & UI Functions ---
        const icons = {
            folder: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#4a90e2"><path d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
            file: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#777"><path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>'
        };

        function getFileIcon(isFolder) {
            return isFolder ? icons.folder : icons.file;
        }

        function formatBytes(bytes) {
            if (!+bytes) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return \`\${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} \${sizes[i]}\`;
        }

        async function copyToClipboard(text, btn) {
            try {
                await navigator.clipboard.writeText(text);
                const originalText = btn.textContent;
                btn.textContent = '已复制!';
                setTimeout(() => { btn.textContent = originalText; }, 2000);
            } catch (err) {
                alert('复制失败');
            }
        }

        function renderBreadcrumb(breadcrumbs) {
            breadcrumbEl.innerHTML = '';
            breadcrumbs.forEach((crumb, index) => {
                const a = document.createElement('a');
                a.href = \`#\${crumb.id === rootFolderId ? '' : crumb.id}\`;
                a.textContent = crumb.name;
                breadcrumbEl.appendChild(a);
                if (index < breadcrumbs.length - 1) {
                    const separator = document.createElement('span');
                    separator.textContent = '>';
                    breadcrumbEl.appendChild(separator);
                }
            });
        }
        
        async function loadFolder(folderId) {
            fileListEl.innerHTML = '';
            loaderEl.style.display = 'block';
            try {
                const res = await fetch(\`/api/list/\${folderId || ''}\`);
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "获取列表失败");
                
                renderBreadcrumb(data.breadcrumbs);

                if (data.files.length === 0) {
                    fileListEl.innerHTML = '<li><p style="text-align:center; color:#888;">此文件夹为空</p></li>';
                    return;
                }
                
                const itemsHtml = data.files.map(file => {
                    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                    const downloadUrl = \`/api/download/\${file.id}?name=\${encodeURIComponent(file.name)}\`;
                    const fileMeta = file.size ? \`<span>\${formatBytes(file.size)}</span> • \` : '';
                    const actions = !isFolder ? \`
                        <div class="file-actions">
                            <button class="action-btn" onclick="location.href='\${downloadUrl}'">下载</button>
                            <button class="action-btn copy-btn" onclick="copyToClipboard(window.location.origin + '\${downloadUrl}', this)">复制直链</button>
                        </div>
                    \` : '';

                    return \`
                        <li class="file-item">
                            <div class="file-icon">\${getFileIcon(isFolder)}</div>
                            <div class="file-info">
                                <span class="file-name \${isFolder ? 'folder' : ''}" \${isFolder ? \`onclick="window.location.hash='\${file.id}'"\` : ''}>\${file.name}</span>
                                <div class="file-meta">\${fileMeta}<span>\${new Date(file.modifiedTime).toLocaleDateString()}</span></div>
                            </div>
                            \${actions}
                        </li>
                    \`;
                }).join('');

                fileListEl.innerHTML = itemsHtml;

            } catch(e) { 
                fileListEl.innerHTML = \`<li><p style="text-align:center; color:red;">加载失败: \${e.message}</p></li>\`;
            } finally {
                loaderEl.style.display = 'none';
            }
        }

        // --- Initializer ---
        function handleNavigation() {
            loadFolder(window.location.hash.substring(1));
        }
        window.addEventListener('hashchange', handleNavigation);
        document.addEventListener('DOMContentLoaded', handleNavigation);
    </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}