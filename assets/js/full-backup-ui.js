(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    let api;
    try { api = RPHubFullBackup.create(); api.pending(); }
    catch (_) { $('status').hidden = false; $('status').textContent = '浏览器存储不可用，请检查存储权限后重开。未读取或写入新家资料。'; document.querySelectorAll('button,input').forEach(b => { b.disabled = true; }); return; }
    let busy = false, plan = null;
    const labels = { characters: '角色', branches: '分支', messages: '聊天原文', summaries: '总结及来源', compressed: '二次压缩', vectors: '向量', worldinfo: '世界书', presets: '预设', letters: '小纸条', records: '资料记录' };
    const globalLabels = { characters: '角色卡与附属设定', settings: '模型、凭证与显示设置', presets: '自定义预设与开关', regex: '正则', global_regex: '全局正则',
        worldinfo: '世界书', global_worldinfo: '全局世界书', worldinfo_settings: '世界书设置', global_ui_templates: '全局 UI 模板', active_tools: '工具设置',
        user: '当前用户人设', user_profiles: '用户人设档案', active_profile_id: '当前人设选择', last_active_char: '当前角色选择', memory_settings: '记忆模式与模型设置',
        chat_preferences_v2: '模型槽位与温度', token_usage_history: '历史用量', proactive_v1: '小纸条互动及计次', 'rphub-appearance': '界面主题',
        rp_hub_visual_cottage_v1: '所在空间与昼夜模式', rp_hub_proactive_config_v1: '小纸条设置' };
    function describe(key, archive) {
        if (globalLabels[key]) return globalLabels[key];
        const name = key.slice(7); if (globalLabels[name]) return globalLabels[name];
        const scoped = /^(chat|classic_memories|branches|mailbox_v2)_(.+)$/.exec(name);
        if (!scoped) return '资料记录';
        const [owner, branch] = scoped[2].split('__branch__');
        const chars = archive.data.records.find(r => r.key === 'rp_hub_characters')?.value || [];
        const characterName = chars.find(c => c.uuid === owner)?.name || '角色';
        const branches = archive.data.records.find(r => r.key === 'rp_hub_branches_' + owner)?.value?.branches || [];
        const branchName = branch ? branches.find(b => b.id === branch)?.name || '支线' : '主线';
        return `${{ chat: '聊天原文', classic_memories: '总结及增强记忆', branches: '分支列表', mailbox_v2: '海神小纸条' }[scoped[1]]} · ${characterName}${['branches', 'mailbox_v2'].includes(scoped[1]) ? '' : ' / ' + branchName}`;
    }
    const status = (text, error = false) => { $('status').hidden = false; $('status').textContent = text; $('status').dataset.error = String(error); };
    function refreshRecovery() {
        const pending = api.pending(); $('recovery').hidden = !pending; $('normal-tools').hidden = !!pending;
        $('return-home').hidden = !!pending;
    }
    async function perform(fn) {
        if (busy) return;
        busy = true; document.querySelectorAll('button,input').forEach(b => { b.disabled = true; });
        try { await fn(); } catch (e) { status(e?.name === 'BackupError' ? e.message : '操作未完成，请检查文件、浏览器能力与可用空间。未输出任何私人资料。', true); }
        finally { busy = false; document.querySelectorAll('button,input').forEach(b => { b.disabled = false; }); $('restore-button').disabled = !$('confirm-restore').checked || !plan; refreshRecovery(); }
    }
    const reset = () => { plan = null; $('preview').hidden = true; $('confirm-restore').checked = false; $('restore-button').disabled = true; };
    function tab(name) {
        if (busy) return;
        for (const mode of ['export', 'restore']) { $(mode + '-panel').hidden = mode !== name; $(mode + '-tab').setAttribute('aria-selected', String(mode === name)); }
        $('status').hidden = true;
    }
    $('export-tab').addEventListener('click', () => tab('export'));
    $('restore-tab').addEventListener('click', () => tab('restore'));
    $('export-button').addEventListener('click', () => perform(async () => {
        const password = $('export-password').value;
        if (password !== $('export-confirm').value) return status('两次密码不一致，请重新确认。', true);
        status('正在读取已保存资料并加密，请稍候…');
        const result = await api.backup(password), blob = new Blob([result.text], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = 'RP-Hub-complete-' + new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) + '.rphub'; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        $('export-password').value = $('export-confirm').value = '';
        status(`加密文件已生成：${result.counts.characters} 个角色，${result.counts.messages} 条原文，${result.counts.summaries} 条总结及来源，${result.counts.vectors} 份向量。\n请确认文件已存入“文件”或安全位置；浏览器不能保证下载已由系统保存。密码无法找回。`);
    }));
    $('backup-file').addEventListener('change', reset);
    $('restore-password').addEventListener('input', reset);
    $('preflight').addEventListener('click', () => perform(async () => {
        reset(); const file = $('backup-file').files[0];
        if (!file) return status('请先选择完整备份文件。', true);
        if (file.size > RPHubFullBackup.constants.MAX_FILE_BYTES) return status('文件超过本版安全处理上限，未读取或写入。', true);
        status('正在解密并逐项预检，暂不写入资料…');
        let text;
        try { text = await file.text(); }
        catch (_) { throw Object.assign(new Error('备份文件读取失败（FILE_READ）；请确认文件已下载到本机，未写入资料'), { name: 'BackupError' }); }
        const archive = await api.decrypt(text, $('restore-password').value);
        plan = await api.preflight(archive);
        $('backup-meta').textContent = '备份时间：' + new Date(archive.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' · 北京时间';
        $('counts').replaceChildren();
        for (const [key, value] of Object.entries(plan.counts)) {
            const item = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
            dt.textContent = labels[key]; dd.textContent = value; item.append(dt, dd); $('counts').append(item);
        }
        const conflicts = plan.changes.filter(c => c.conflict).length;
        $('change-summary').textContent = `${plan.changes.length} 项需要写入，其中 ${conflicts} 项与目标不同。相同记录不重复导入。${plan.capacity.available === null ? '浏览器未提供容量估算，最终写入仍可能因空间不足回退。' : '可用存储空间预检通过。'}`;
        $('changes').replaceChildren();
        for (const c of plan.changes) {
            const li = document.createElement('li');
            const clearsStaleMemory = c.key.startsWith('rp_hub_classic_memories_') && !plan.archive.data.records.some(r => r.key === c.key);
            li.textContent = `${c.conflict ? '冲突 · 确认后以备份恢复' : '新增'}：${describe(c.key, plan.archive)}${clearsStaleMemory ? '（备份无此摘要，将移除不匹配的目标摘要）' : ''}`;
            $('changes').append(li);
        }
        $('preview').hidden = false; status('解密与预检通过。请核对数量和冲突，再明确确认恢复。');
    }));
    $('confirm-restore').addEventListener('change', () => { $('restore-button').disabled = busy || !plan || !$('confirm-restore').checked; });
    $('restore-button').addEventListener('click', () => perform(async () => {
        if (!plan || !$('confirm-restore').checked) return;
        status('正在保存加密回退记录、恢复并核对，请勿关闭…');
        const result = await api.restore(plan, $('restore-password').value, { planDigest: plan.planDigest, replaceConflicts: true });
        $('restore-password').value = ''; reset();
        status(result.status === 'unchanged' ? '资料已一致，无需重复写入。原推送身份保持不变。' : '完整性验证通过。资料已恢复，原推送身份未触碰。\n可返回小家检查；请继续保留 Safari 原数据与原备份文件。');
    }));
    for (const [id, mode] of [['resume', 'resume'], ['rollback', 'rollback']]) $(id).addEventListener('click', () => perform(async () => {
        status(mode === 'resume' ? '正在继续恢复并核对…' : '正在回退并核对…');
        const result = await api.recover($('recovery-password').value, mode); $('recovery-password').value = '';
        status(result.status === 'rolled-back' ? '已回退并核对恢复前资料。推送身份未触碰。' : '恢复与逐项核对已完成，可返回小家。');
    }));
    try { refreshRecovery(); } catch (_) { status('无法读取本机恢复状态，请检查浏览器存储权限。', true); }
})();
