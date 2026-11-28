// Allowlisted UI preferences only. API credentials continue using the existing settings path.
(function () {
    const modes = ['quality', 'balanced', 'fast'];
    const slotKey = mode => `${mode}Model`;
    const temperature = value => value !== null && value !== '' && Number.isFinite(Number(value))
        ? Math.max(0, Math.min(1, Number(value))) : 1;
    const snapshot = settings => ({
        temperature: temperature(settings.temperature),
        showMemoryCitations: settings.showMemoryCitations === true,
        selectedModelSlot: modes.includes(settings.selectedModelSlot) ? settings.selectedModelSlot : 'quality',
        model: String(settings.model || ''), qualityModel: String(settings.qualityModel || ''),
        balancedModel: String(settings.balancedModel || ''), fastModel: String(settings.fastModel || '')
    });
    const restore = (settings, saved) => {
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            for (const name of ['temperature', 'selectedModelSlot', 'model', 'qualityModel', 'balancedModel', 'fastModel', 'showMemoryCitations']) {
                if (Object.prototype.hasOwnProperty.call(saved, name)) settings[name] = saved[name];
            }
        }
        settings.temperature = temperature(settings.temperature);
        settings.showMemoryCitations = settings.showMemoryCitations === true;
        const selected = modes.includes(settings.selectedModelSlot) ? settings.selectedModelSlot : null;
        const mode = selected && settings[slotKey(selected)] === settings.model ? selected
            : modes.find(item => settings[slotKey(item)] && settings[slotKey(item)] === settings.model)
                || (selected && settings[slotKey(selected)] ? selected : modes.find(item => settings[slotKey(item)]));
        settings.selectedModelSlot = mode || 'quality';
        if (mode && settings[slotKey(mode)]) settings.model = settings[slotKey(mode)];
    };
    window.RPHubChatPreferences = Object.freeze({ snapshot, restore });
})();
