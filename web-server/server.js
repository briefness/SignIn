const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const localtunnel = require('localtunnel');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// 适配 Vercel 环境
const isVercel = process.env.VERCEL === '1';
const isPkg = typeof process.pkg !== 'undefined';

// 路径配置：
// 1. Vercel: 使用 /tmp 存储临时数据 (重启后清空)，使用 process.cwd() 或 __dirname 找静态资源
// 2. Pkg: 使用 process.execPath 找可执行文件旁边的资源
// 3. 开发环境: 使用 __dirname
const BASE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');

// Vercel 文件系统只读，只能写 /tmp
// 注意：每次部署或实例重启，/tmp 都会清空 -> 符合“阅后即焚”的需求
const DB_FILE = isVercel ? path.join('/tmp', 'db.json') : path.join(BASE_DIR, 'db.json');

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(PUBLIC_DIR));

// 显式路由：访问根路径返回 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// 初始化数据库
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

// 读写辅助函数
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE));
const writeDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// API: 获取统计
app.get('/api/stats', (req, res) => {
    const list = readDB();
    const checkedInList = list.filter(i => i.status === 'checked_in');
    
    // 现场新增人数 (有 isNew 标记 或 source 为 scan_new)
    const newCheckedIn = checkedInList.filter(i => i.isNew || i.source === 'scan_new').length;
    
    // 名单内签到人数 (总签到 - 新增)
    const originalCheckedIn = checkedInList.length - newCheckedIn;
    
    // 原始名单总人数 (排除现场新增的)
    const originalTotal = list.filter(i => !i.isNew).length;

    res.json({ 
        total: originalTotal, // 修正为仅返回原始名单人数
        checkedIn: checkedInList.length,
        newCheckedIn,
        originalCheckedIn
    });
});

// API: 获取列表
app.get('/api/list', (req, res) => {
    const list = readDB();
    // 按签到时间倒序
    const sorted = list.sort((a, b) => (b.checkInTime || 0) - (a.checkInTime || 0));
    res.json(sorted);
});

// 辅助函数：计算两个字符串的差异字符数 (仅适用于等长)
function getDiffCount(s1, s2) {
    if (s1.length !== s2.length) return 999;
    let diff = 0;
    for (let i = 0; i < s1.length; i++) {
        if (s1[i] !== s2[i]) diff++;
    }
    return diff;
}

// API: 签到/报名
app.post('/api/checkin', (req, res) => {
    // confirmNew: 用户确认是新人 (强制创建)
    // useExistingPhone: 用户确认是老用户 (使用此 Correct Phone)
    const { name, phone, confirmNew, useExistingPhone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '请填写完整信息' });

    const list = readDB();

    // -----------------------------------------------------
    // 逻辑 A: 处理“确认使用现有身份”的情况 (来自前端弹窗确认)
    // -----------------------------------------------------
    if (useExistingPhone) {
        const idx = list.findIndex(i => i.phone === useExistingPhone);
        if (idx > -1) {
            // 检查之前是否已经签到
            if (list[idx].status === 'checked_in') {
                return res.json({ success: false, error: `用户 ${list[idx].name} 已经签到过了，无需重复！` });
            }
            // 执行签到
            list[idx].status = 'checked_in';
            list[idx].checkInTime = Date.now();
            writeDB(list);
            return res.json({ success: true, user: list[idx], isNew: false });
        }
    }

    // -----------------------------------------------------
    // 逻辑 B: 精确查找 (标准流程)
    // -----------------------------------------------------
    const existingIndex = list.findIndex(i => i.phone === phone);
    
    if (existingIndex > -1) {
        // 找到了精确匹配
        const current = list[existingIndex];
        
        // 1. 先检查名字是否也匹配? (可选，若只需要手机匹配即可，则跳过)
        // 2. 检查是否已签到
        if (current.status === 'checked_in') {
             return res.json({ success: false, error: `您好 ${current.name}，您于 ${new Date(current.checkInTime).toLocaleTimeString()} 已经签到过了，请勿经重复扫码。` });
        }

        // 执行签到
        list[existingIndex].status = 'checked_in';
        list[existingIndex].checkInTime = Date.now();
        // 补全名字
        if (!list[existingIndex].name) list[existingIndex].name = name;
        
        writeDB(list);
        return res.json({ success: true, user: list[existingIndex], isNew: false });
    }

    // -----------------------------------------------------
    // 逻辑 C: 没找到精确手机号 -> 进入“模糊/防呆”检查
    // -----------------------------------------------------
    if (!confirmNew) {
        // 1. 检查手机号是否有“极似”的 (只差1位)
        const phoneCandidates = list.filter(u => getDiffCount(u.phone, phone) === 1);
        
        // 2. 检查同名 (现有逻辑)
        const nameMatches = list.filter(i => i.name === name);

        // 合并候选人 (去重)
        const allCandidates = [...phoneCandidates, ...nameMatches].filter((item, index, self) => 
            index === self.findIndex((t) => (t.phone === item.phone))
        );

        if (allCandidates.length > 0) {
            // 返回给前端让用户认领
            return res.json({
                success: false,
                requiresConfirmation: true,
                candidates: allCandidates.map(u => ({
                    name: u.name,
                    phone: u.phone,
                    maskedPhone: u.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
                    matchType: (u.name === name) ? '同名' : '号码相似' // 简单的提示标记
                }))
            });
        }
    }

    // -----------------------------------------------------
    // 逻辑 D: 确实是新人 (或者用户放弃认领)
    // -----------------------------------------------------
    const newUser = {
        name,
        phone,
        status: 'checked_in',
        checkInTime: Date.now(),
        source: 'web_scan',
        isNew: true
    };
    list.push(newUser);
    
    writeDB(list);
    res.json({ success: true, user: newUser, isNew: true });
});

// API: 获取穿透链接和二维码
let tunnelUrl = '';
let qrCodeData = '';

app.get('/api/tunnel', (req, res) => {
    res.json({ url: tunnelUrl, qr: qrCodeData });
});

// 启动 SSH 隧道 (localhost.run)
function startTunnel() {
    const { spawn } = require('child_process');
    // 使用 ssh -R 80:localhost:3000 localhost.run --nopty
    const ssh = spawn('ssh', ['-R', '80:localhost:' + PORT, 'nokey@localhost.run', '-o', 'StrictHostKeyChecking=no']);

    ssh.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('SSH Output:', output);
        // 解析 URL (精确匹配 http/https 开头，到空格或行尾结束)
        const match = output.match(/(https?:\/\/[a-zA-Z0-9-]+\.(lhr\.life|localhost\.run))/);
        if (match) {
            tunnelUrl = match[1].trim(); // 确保去除空格
            console.log(`内网穿透成功 (localhost.run): ${tunnelUrl}`);
            
            // 生成二维码
            const fullUrl = tunnelUrl + '/form.html';
            console.log('生成二维码链接:', fullUrl);
            
            QRCode.toDataURL(fullUrl).then(url => {
                qrCodeData = url;
            });
        }
    });

    ssh.stderr.on('data', (data) => {
        const output = data.toString();
        // 同样处理 stderr
        const match = output.match(/(https?:\/\/[a-zA-Z0-9-]+\.(lhr\.life|localhost\.run))/);
        if (match) {
            tunnelUrl = match[1].trim();
            console.log(`内网穿透成功 (localhost.run): ${tunnelUrl}`);
            
            const fullUrl = tunnelUrl + '/form.html';
            console.log('生成二维码链接:', fullUrl);

            QRCode.toDataURL(fullUrl).then(url => {
                qrCodeData = url;
            });
        }
    });

    ssh.on('close', (code) => {
        console.log(`隧道进程已退出 (Code: ${code})，正在重试...`);
        setTimeout(startTunnel, 5000); // 断线重连
    });
}

// 启动服务
const multer = require('multer');
const xlsx = require('xlsx');
const upload = multer({ dest: 'uploads/' });

// API: 导入 Excel/CSV
app.post('/api/import', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '请选择文件' });
        
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(sheet);
        
        // 转换数据格式 (适配表头)
        const formatList = jsonData.map(row => {
            // 尝试常见表头
            const name = row['姓名'] || row['Name'] || row['name'];
            const phone = row['手机'] || row['手机号'] || row['手机号码'] || row['Phone'] || row['phone'];
            if (!name || !phone) return null;
            return {
                name: String(name).trim(),
                phone: String(phone).trim(),
                status: 'pending' // 默认为未签到
            };
        }).filter(item => item !== null);

        // 覆盖模式：直接替换 db.json
        // 如果要追加，可以先 readDB() 然后 concat
        writeDB(formatList); 
        
        // 清理临时文件
        fs.unlinkSync(req.file.path);
        
        res.json({ success: true, count: formatList.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '解析失败: ' + err.message });
    }
});

// API: 导出 Excel
app.get('/api/export', (req, res) => {
    try {
        const list = readDB();
        // 转换为导出格式
        const exportData = list.map(user => ({
            '姓名': user.name,
            '手机号': user.phone,
            '状态': user.status === 'checked_in' ? '已签到' : '未签到',
            '签到时间': user.checkInTime ? new Date(user.checkInTime).toLocaleString() : '',
            '新人标记': user.isNew ? '是' : '', // 导出时标记
            '来源': user.source === 'scan_new' || user.isNew ? '现场录入' : '导入'
        }));

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, "签到名单");
        
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', 'attachment; filename="sign_in_data.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) {
        console.error(err);
        res.status(500).send('导出失败');
    }
});

app.listen(PORT, async () => {
    console.log(`服务运行于 http://localhost:${PORT}`);
    // 只有在非 Vercel 环境下才启动内网穿透
    if (!isVercel) {
        startTunnel();
    }
});
