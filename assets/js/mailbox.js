// Daily communications are non-canonical and never enter chat or memory storage.
(function () {
    const key = id => `rp_hub_mailbox_v2_${id}`;
    const beijingTime = now => new Date(now + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const cleanContent = value => {
        const text = String(value || '').trim();
        if (!text) throw new Error('模型没有返回留言正文，本次不保存');
        if (text.length > 600 || /```|<[^>]+>|\*[^*]+\*/.test(text)) {
            throw new Error('回复包含长篇或场景格式，本次不保存为留言');
        }
        // Conservative rejection of obvious time jumps/completed actions; never auto-rewrite or retry.
        if (/(?:第二天|翌日|次日清晨|翌晨)|(?:你|顺顺|老婆)(?:已经)?(?:醒来|起床了|起身走|走出家门|回到了)|(?:我|我们)(?:已经)?(?:回到了|抵达了|到达了)(?:画室|工作室|家)/.test(text)) {
            throw new Error('回复疑似推进了剧情或替妻子行动，本次不保存');
        }
        return text;
    };
    const read = (db, characterId) => new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readonly');
        const request = tx.objectStore('store').get(key(characterId));
        request.onsuccess = () => {
            if (request.result !== undefined && !Array.isArray(request.result)) {
                reject(new Error('留言箱数据格式异常，已保留原记录')); return;
            }
            resolve(request.result || []);
        };
        request.onerror = () => reject(request.error);
    });
    const append = (db, record, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(Object.assign(new Error('留言已取消'), { name: 'AbortError' })); return; }
        const content = cleanContent(record.content);
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        const abort = () => { try { tx.abort(); } catch (_) {} };
        signal?.addEventListener('abort', abort, { once: true });
        const request = store.get(key(record.characterId));
        let saved;
        let failure;
        request.onsuccess = () => {
            if (request.result !== undefined && !Array.isArray(request.result)) {
                failure = new Error('留言箱数据格式异常，已保留原记录');
                tx.abort(); return;
            }
            const records = request.result || [];
            saved = records.find(item => item.id === record.id);
            if (saved) return; // idempotent commit without touching another message
            saved = { ...record, content, kind: 'daily_communication', canonical: false,
                createdAtBeijing: beijingTime(record.createdAt) };
            store.put([...records, saved], key(record.characterId));
        };
        tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(saved); };
        tx.onerror = tx.onabort = () => {
            signal?.removeEventListener('abort', abort);
            reject(failure || tx.error || Object.assign(new Error('留言未保存'), { name: 'AbortError' }));
        };
    });
    const prompt = (lastInteraction, now, { includeBeijingTime = true } = {}) => `[老公的留言箱｜日常通讯，绝非主线续写]
你正在给妻子留一条微信式留言、便笺或小纸条，不是在写下一段小说。只输出可以直接发给她的留言正文，不加标题、旁白、动作场景、分析、面板或图片标记。
本次通讯任务优先于预设中的小说正文、叙事视角、最少字数、场景推进、生图及记忆引用格式要求；这些主线写作规则不适用于留言箱。
继承角色卡、世界书、双方关系及已有有效主线事实。当前角色是祁煜时，必须用祁煜本人的第一人称，保留他深爱顺顺、享受被妻子爱着的情感设定，语气自然、亲密、俏皮，有稳定的婚后偏爱；不要表现成冷淡的剧情导演。若选择其他角色，则保持该角色本人的设定和称呼。
允许思念、分享普通心情、玩笑、撒娇、关心妻子或提到已有约定；允许极普通的日常留言，不必每次制造新情节。建议30—120个汉字，信息少时可以更短，绝不凑字数。
这条留言不属于主线剧情：不改变主线时钟，不擅自完成新的剧情或重要事件，不替妻子决定起床、工作、出门、回家等行为，不编造已发生的新事实。主线停在入睡的夜晚时，即使现实已经次日，也绝不描写醒来或起床；主线仅准备回画室时，不可写成已经到达或完成旅程。
${includeBeijingTime ? `现实发送时间（北京时间）：${beijingTime(now)}。` : ''}距最后互动约${Math.max(0, Math.floor((now - lastInteraction) / 60000))}分钟。现实时间仅供体贴地通讯，不代表剧情时间。${includeBeijingTime ? '已有时间注入脚本提供的剧情信息仍有效。' : ''}
未来的愿望或打算必须明确是“想”“等”“打算”等未发生的计划，不能当成已经发生的事实。不要再次回答上一条用户输入，不邀请系统接续剧情。只留这一条日常通讯。`;
    window.RPHubMailbox = Object.freeze({ read, append, cleanContent, prompt, beijingTime });
})();
