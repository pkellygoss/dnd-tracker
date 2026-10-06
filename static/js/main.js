/* ===========================================================
   D&D CHARACTER SHEET — Client-side Logic
   =========================================================== */

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ---------------------------------------------------------------------------
// API Helper
// ---------------------------------------------------------------------------

async function api(url, data = null) {
    const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    };
    if (data !== null) opts.body = JSON.stringify(data);
    try {
        const res = await fetch(url, opts);
        const json = await res.json();
        if (!res.ok || json.error) {
            showToast(json.error || 'Request failed', 'error');
            return null;
        }
        return json;
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
        return null;
    }
}

function readEffectsJson(textareaId) {
    const raw = document.getElementById(textareaId)?.value?.trim() || '';
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            showToast('Effects JSON must be an array', 'error');
            return null;
        }
        return parsed;
    } catch (err) {
        showToast('Effects JSON is not valid JSON', 'error');
        console.error(err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Image Upload Helper
// ---------------------------------------------------------------------------

/**
 * Trigger a file upload for an image field.
 * @param {string} folder - upload folder (spells, abilities, journal, party, character)
 * @param {string} targetInputId - ID of the text input to fill with the resulting URL
 * @param {Function} [onComplete] - optional callback after successful upload
 */
function uploadImage(folder, targetInputId, onComplete) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;

        // Size check
        if (file.size > 10 * 1024 * 1024) {
            showToast('File too large (max 10MB)', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', folder);

        showToast('Uploading...', 'info');

        try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const json = await res.json();
            if (!res.ok || json.error) {
                showToast(json.error || 'Upload failed', 'error');
                return;
            }
            // Put the URL (or local filename) into the target input
            const target = document.getElementById(targetInputId);
            if (target) {
                target.value = json.url;
                target.dispatchEvent(new Event('change'));
            }
            showToast('Image uploaded!', 'success');
            if (onComplete) onComplete(json);
        } catch (err) {
            showToast('Upload failed', 'error');
            console.error(err);
        }
    };
    fileInput.click();
}

/**
 * Resolve an image value to a displayable URL.
 * Full URLs pass through; plain filenames get the static prefix.
 */
function resolveImageUrl(value, folder) {
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    // "folder/name.png" is an image stored on this device (loaded lazily by images.js); bare names are bundled
    if (value.includes('/')) return `idb:${value}`;
    return `static/images/${folder}/${value}`;
}


// ---------------------------------------------------------------------------
// Panel Toggle (Edit mode)
// ---------------------------------------------------------------------------

function toggleEditPanel(name) {
    const display = document.getElementById(`${name}-display`);
    const edit = document.getElementById(`${name}-edit`);
    if (display && edit) {
        display.classList.toggle('hidden');
        edit.classList.toggle('hidden');
    }
}

// ---------------------------------------------------------------------------
// Character Identity
// ---------------------------------------------------------------------------

async function saveIdentity() {
    const data = {
        name: document.getElementById('edit-name')?.value || '',
        race: document.getElementById('edit-race')?.value || '',
        level: parseInt(document.getElementById('edit-level')?.value) || 1,
        background: document.getElementById('edit-background')?.value || '',
        alignment: document.getElementById('edit-alignment')?.value || '',
        character_class: document.getElementById('edit-class')?.value || 'Bard',
        subclass: document.getElementById('edit-subclass')?.value || '',
        portrait: document.getElementById('edit-portrait')?.value || '',
    };
    const appearance = document.getElementById('edit-appearance');
    if (appearance) data.appearance = appearance.value;
    const result = await api('/api/character/update', data);
    if (result?.ok) {
        showToast('Character updated', 'success');
        // Reload to recalculate all derived stats
        setTimeout(() => location.reload(), 300);
    }
}

function updateEditSubclassOptions() {
    if (typeof SUBCLASS_OPTIONS === 'undefined') return;
    const cls = document.getElementById('edit-class')?.value;
    const sel = document.getElementById('edit-subclass');
    if (!cls || !sel) return;
    const subs = SUBCLASS_OPTIONS[cls] || [];
    sel.innerHTML = '<option value="">— None —</option>';
    subs.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
    });
}

// ---------------------------------------------------------------------------
// Ability Scores
// ---------------------------------------------------------------------------

async function saveAbilities() {
    const scores = {};
    document.querySelectorAll('[data-ability]').forEach(input => {
        scores[input.dataset.ability] = parseInt(input.value) || 10;
    });
    const result = await api('/api/character/update', { ability_scores: scores });
    if (result?.ok) {
        showToast('Ability scores updated', 'success');
        setTimeout(() => location.reload(), 300);
    }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

async function saveSkills() {
    const proficiencies = [];
    const expertise = [];
    const tempBonuses = {};

    document.querySelectorAll('.skill-prof-select').forEach(sel => {
        const skill = sel.dataset.skill;
        if (sel.value === 'proficient') proficiencies.push(skill);
        else if (sel.value === 'expertise') {
            proficiencies.push(skill);
            expertise.push(skill);
        }
    });

    document.querySelectorAll('[data-skill-temp]').forEach(input => {
        const val = parseInt(input.value) || 0;
        tempBonuses[input.dataset.skillTemp] = val;
    });

    const result = await api('/api/character/update', {
        proficiencies,
        expertise,
        temp_skill_bonuses: tempBonuses,
    });
    if (result?.ok) {
        showToast('Skills updated', 'success');
        setTimeout(() => location.reload(), 300);
    }
}

// ---------------------------------------------------------------------------
// HP Management
// ---------------------------------------------------------------------------

function updateHPBar() {
    const current = parseInt(document.getElementById('hp-current')?.value) || 0;
    const max = parseInt(document.getElementById('hp-max')?.value) || 1;
    const pct = Math.max(0, Math.min(100, (current / max) * 100));
    const bar = document.getElementById('hp-bar');
    if (bar) {
        bar.style.width = pct + '%';
        if (pct > 50) bar.style.background = 'var(--hp-green)';
        else if (pct > 25) bar.style.background = 'var(--hp-yellow)';
        else bar.style.background = 'var(--hp-red)';
    }
    // Color the HP input
    const hpInput = document.getElementById('hp-current');
    if (hpInput) {
        if (pct > 50) hpInput.style.color = 'var(--hp-green)';
        else if (pct > 25) hpInput.style.color = 'var(--hp-yellow)';
        else hpInput.style.color = 'var(--hp-red)';
    }
}

let hpSaveTimeout;

function updateHP() {
    updateHPBar();
    clearTimeout(hpSaveTimeout);
    hpSaveTimeout = setTimeout(async () => {
        const hpMaxInput = document.getElementById('hp-max');
        const hpMaxEffectBonus = parseInt(hpMaxInput?.dataset?.effectBonus || '0', 10) || 0;
        const effectiveHpMax = parseInt(hpMaxInput?.value) || 0;

        await api('/api/character/update', {
            hp_current: parseInt(document.getElementById('hp-current')?.value) || 0,
            hp_max: Math.max(0, effectiveHpMax - hpMaxEffectBonus),
            hp_temp: parseInt(document.getElementById('hp-temp')?.value) || 0,
        });
    }, 500);
}

function quickHP(amount) {
    const input = document.getElementById('hp-current');
    const maxInput = document.getElementById('hp-max');
    if (!input || !maxInput) return;

    let current = parseInt(input.value) || 0;
    const max = parseInt(maxInput.value) || 0;

    if (amount < 0) {
        // Handle temp HP first
        const tempInput = document.getElementById('hp-temp');
        let temp = parseInt(tempInput?.value) || 0;
        let dmg = Math.abs(amount);

        if (temp > 0) {
            const tempAbsorb = Math.min(temp, dmg);
            temp -= tempAbsorb;
            dmg -= tempAbsorb;
            tempInput.value = temp;
        }
        current = Math.max(0, current - dmg);
    } else {
        current = Math.min(max, current + amount);
    }

    input.value = current;
    updateHP();
}

// ---------------------------------------------------------------------------
// Death Saves
// ---------------------------------------------------------------------------

function updateDeathSaves() {
    const successChecks = document.querySelectorAll('.death-check.success');
    const failureChecks = document.querySelectorAll('.death-check.failure');

    let successes = 0;
    let failures = 0;
    successChecks.forEach(cb => { if (cb.checked) successes++; });
    failureChecks.forEach(cb => { if (cb.checked) failures++; });

    api('/api/character/update', {
        death_saves: { successes, failures }
    });
}

// ---------------------------------------------------------------------------
// Bardic Inspiration
// ---------------------------------------------------------------------------

async function useInspiration() {
    const result = await api('/api/inspiration/use');
    if (result?.ok) {
        showToast(`Bardic Inspiration used! (${result.remaining} remaining)`, 'info');
        setTimeout(() => location.reload(), 300);
    }
}

// ---------------------------------------------------------------------------
// Spell Slots
// ---------------------------------------------------------------------------

async function useSlotPip(level, element) {
    // Check if this pip is available (to use) or used (to restore)
    if (element.classList.contains('available')) {
        const result = await api('/api/spell/cast', { slot_level: level });
        if (result?.ok) {
            element.classList.remove('available');
            element.classList.add('used');
            updateSlotCount(level, result.remaining, result.max);
            showToast(`Level ${level} slot used (${result.remaining} remaining)`, 'info');
        }
    } else {
        // Restore a slot
        const result = await api('/api/slots/restore', { slot_level: level });
        if (result?.ok) {
            element.classList.remove('used');
            element.classList.add('available');
            showToast(`Level ${level} slot restored`, 'success');
            // Just reload to refresh counts cleanly
            setTimeout(() => location.reload(), 300);
        }
    }
}

function updateSlotCount(level, remaining, max) {
    const countEl = document.getElementById(`slot-count-${level}`);
    if (countEl) countEl.textContent = `${remaining}/${max}`;
}

// ---------------------------------------------------------------------------
// Hit Dice
// ---------------------------------------------------------------------------

async function spendHitDie() {
    const el = document.getElementById('hitdice-remaining');
    const current = parseInt(el?.textContent) || 0;
    if (current <= 0) { showToast('No hit dice remaining', 'error'); return; }
    const result = await api('/api/character/update', { hit_dice_remaining: current - 1 });
    if (result?.ok) {
        el.textContent = current - 1;
        showToast('Spent 1 hit die', 'success');
    }
}

// ---------------------------------------------------------------------------
// Rest
// ---------------------------------------------------------------------------

async function shortRest() {
    if (!confirm('Take a short rest?')) return;
    const result = await api('/api/rest/short');
    if (result?.ok) {
        result.messages.forEach(m => showToast(m, 'success'));
        setTimeout(() => location.reload(), 800);
    }
}

async function longRest() {
    if (!confirm('Take a long rest? This restores HP, spell slots, and Bardic Inspiration.')) return;
    const result = await api('/api/rest/long');
    if (result?.ok) {
        result.messages.forEach((m, i) => {
            setTimeout(() => showToast(m, 'success'), i * 200);
        });
        setTimeout(() => location.reload(), 1500);
    }
}

// ---------------------------------------------------------------------------
// Languages & Tools
// ---------------------------------------------------------------------------

async function saveLanguages() {
    const langs = document.getElementById('edit-languages')?.value
        .split(',').map(s => s.trim()).filter(Boolean);
    const tools = document.getElementById('edit-tools')?.value
        .split(',').map(s => s.trim()).filter(Boolean);

    const result = await api('/api/character/update', {
        languages: langs,
        tool_proficiencies: tools,
    });
    if (result?.ok) {
        showToast('Languages & tools updated', 'success');
        setTimeout(() => location.reload(), 300);
    }
}

// ---------------------------------------------------------------------------
// Notes (auto-save)
// ---------------------------------------------------------------------------

let notesSaveTimeout;

function saveNotes() {
    clearTimeout(notesSaveTimeout);
    notesSaveTimeout = setTimeout(async () => {
        const notes = document.getElementById('char-notes')?.value || '';
        await api('/api/character/update', { notes });
    }, 1000);
}

// ---------------------------------------------------------------------------
// Armor & Defense
// ---------------------------------------------------------------------------

let armorSaveTimeout;

function saveArmor() {
    clearTimeout(armorSaveTimeout);
    armorSaveTimeout = setTimeout(async () => {
        const speedInput = document.getElementById('edit-speed');
        const speedEffectBonus = parseInt(speedInput?.dataset?.effectBonus || '0', 10) || 0;
        const effectiveSpeed = parseInt(speedInput?.value) || 30;

        const result = await api('/api/character/update', {
            armor_bonus: parseInt(document.getElementById('edit-armor-bonus')?.value) || 0,
            has_shield: document.getElementById('edit-shield')?.checked || false,
            speed: Math.max(0, effectiveSpeed - speedEffectBonus),
        });
        if (result?.ok) {
            showToast('Defense updated', 'success');
            setTimeout(() => location.reload(), 300);
        }
    }, 500);
}

// ---------------------------------------------------------------------------
// Spell Cards
// ---------------------------------------------------------------------------

function flipCard(cardEl) {
    cardEl.classList.toggle('flipped');
}

function filterSpells(level, btn) {
    // Update active filter
    document.querySelectorAll('.spell-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Filter cards
    document.querySelectorAll('.spell-card-wrapper').forEach(wrapper => {
        if (level === 'all') {
            wrapper.style.display = '';
        } else if (level === 'prepared') {
            wrapper.style.display = wrapper.dataset.spellUnprepared === 'false' ? '' : 'none';
        } else if (level === 'unprepared') {
            wrapper.style.display = wrapper.dataset.spellUnprepared === 'true' ? '' : 'none';
        } else {
            const spellLevel = parseInt(wrapper.dataset.spellLevel);
            wrapper.style.display = (spellLevel === level) ? '' : 'none';
        }
    });

    // Show/hide section divider
    document.querySelectorAll('.spell-section-divider').forEach(div => {
        if (level === 'all') {
            div.style.display = '';
        } else if (level === 'unprepared') {
            div.style.display = '';
        } else {
            div.style.display = 'none';
        }
    });
}

async function castSpell(spellId, level, name) {
    const result = await api('/api/spell/cast', { slot_level: level });
    if (result?.ok) {
        if (level === 0) {
            showToast(`${ name } cast!`, 'success');
        } else {
            showToast(`${ name } cast at level ${level}! (${result.remaining} slots remaining)`, 'success');
            // Update slot display
            setTimeout(() => location.reload(), 500);
        }
    }
}

async function castSpellAtLevel(spellId, name) {
    const select = document.getElementById(`cast-level-${spellId}`);
    const level = parseInt(select?.value) || 1;
    await castSpell(spellId, level, name);
}

// ---------------------------------------------------------------------------
// Spell CRUD
// ---------------------------------------------------------------------------

function showAddSpellModal() {
    document.getElementById('add-spell-modal')?.classList.remove('hidden');
}

function hideAddSpellModal() {
    document.getElementById('add-spell-modal')?.classList.add('hidden');
}

async function saveNewSpell() {
    const data = {
        name: document.getElementById('new-spell-name')?.value || '',
        level: parseInt(document.getElementById('new-spell-level')?.value) || 0,
        school: document.getElementById('new-spell-school')?.value || '',
        casting_time: document.getElementById('new-spell-casting')?.value || '1 Action',
        range: document.getElementById('new-spell-range')?.value || 'Self',
        components: document.getElementById('new-spell-components')?.value || 'V, S',
        duration: document.getElementById('new-spell-duration')?.value || 'Instantaneous',
        concentration: document.getElementById('new-spell-concentration')?.checked || false,
        ritual: document.getElementById('new-spell-ritual')?.checked || false,
        image: document.getElementById('new-spell-image')?.value || '',
        description: document.getElementById('new-spell-desc')?.value || '',
    };

    if (!data.name) {
        showToast('Spell name is required', 'error');
        return;
    }

    const result = await api('/api/spell/add', data);
    if (result?.ok) {
        showToast(`${data.name} added to spellbook`, 'success');
        hideAddSpellModal();
        setTimeout(() => location.reload(), 300);
    }
}

async function deleteSpell(spellId, name) {
    if (!confirm(`Remove ${name} from your spellbook?`)) return;
    const result = await api(`/api/spell/${spellId}/delete`);
    if (result?.ok) {
        showToast(`${name} removed`, 'info');
        const wrapper = document.querySelector(`[data-spell-id="${spellId}"]`);
        if (wrapper) {
            wrapper.style.transition = 'opacity 0.3s, transform 0.3s';
            wrapper.style.opacity = '0';
            wrapper.style.transform = 'scale(0.9)';
            setTimeout(() => wrapper.remove(), 300);
        }
    }
}

async function togglePrepared(spellId, currentlyUnprepared) {
    const newState = !currentlyUnprepared;
    const result = await api(`/api/spell/${spellId}/update`, { unprepared: newState });
    if (result?.ok) {
        showToast(newState ? 'Spell unprepared' : 'Spell prepared!', 'success');
        setTimeout(() => location.reload(), 300);
    }
}

// ---------------------------------------------------------------------------
// Inventory CRUD
// ---------------------------------------------------------------------------

function showAddItemModal() {
    document.getElementById('add-item-modal')?.classList.remove('hidden');
}

function hideAddItemModal() {
    document.getElementById('add-item-modal')?.classList.add('hidden');
}

function applyItemEffectPreset() {
    const preset = document.getElementById('new-item-effect-preset')?.value || '';
    if (!preset) return;

    const bonusMap = {
        rhythm_makers_drum_1: 1,
        rhythm_makers_drum_2: 2,
        rhythm_makers_drum_3: 3,
    };

    const bonus = bonusMap[preset];
    if (!bonus) return;

    const nameInput = document.getElementById('new-item-name');
    const descInput = document.getElementById('new-item-desc');
    const equippedInput = document.getElementById('new-item-equipped');
    const requiresInput = document.getElementById('new-item-requires-attunement');
    const attunedInput = document.getElementById('new-item-attuned');
    const effectsInput = document.getElementById('new-item-effects');

    if (nameInput && !nameInput.value) nameInput.value = `Rhythm Maker's Drum +${bonus}`;
    if (descInput && !descInput.value) {
        descInput.value = `Adds +${bonus} to spell save DC and spell attack while equipped and attuned.`;
    }
    if (equippedInput) equippedInput.checked = true;
    if (requiresInput) requiresInput.checked = true;
    if (attunedInput) attunedInput.checked = true;
    if (effectsInput) {
        effectsInput.value = JSON.stringify([
            { target: 'spell_save_dc', mode: 'bonus', value: bonus, condition: 'equipped_and_attuned' },
            { target: 'spell_attack', mode: 'bonus', value: bonus, condition: 'equipped_and_attuned' },
        ], null, 2);
    }
}

async function saveNewItem() {
    const effects = readEffectsJson('new-item-effects');
    if (effects === null) return;

    const requiresAttunement = document.getElementById('new-item-requires-attunement')?.checked || false;
    const attuned = document.getElementById('new-item-attuned')?.checked || false;

    const data = {
        name: document.getElementById('new-item-name')?.value || '',
        quantity: parseInt(document.getElementById('new-item-qty')?.value) || 1,
        weight: parseFloat(document.getElementById('new-item-weight')?.value) || 0,
        description: document.getElementById('new-item-desc')?.value || '',
        equipped: document.getElementById('new-item-equipped')?.checked || false,
        requires_attunement: requiresAttunement || attuned,
        attuned: attuned,
        effects,
    };

    if (!data.name) {
        showToast('Item name is required', 'error');
        return;
    }

    const result = await api('/api/inventory/add', data);
    if (result?.ok) {
        showToast(`${data.name} added to inventory`, 'success');
        hideAddItemModal();
        setTimeout(() => location.reload(), 300);
    }
}

async function toggleEquip(itemId, equip) {
    const result = await api(`/api/inventory/${itemId}/update`, { equipped: equip });
    if (result?.ok) {
        showToast(equip ? 'Item equipped' : 'Item unequipped', 'info');
        setTimeout(() => location.reload(), 300);
    }
}

async function toggleAttunement(itemId, attuned) {
    const result = await api(`/api/inventory/${itemId}/update`, { attuned });
    if (result?.ok) {
        showToast(attuned ? 'Item attuned' : 'Item unattuned', 'info');
        setTimeout(() => location.reload(), 300);
    }
}

async function editItemQty(itemId, currentQty) {
    const newQty = prompt('Enter new quantity:', currentQty);
    if (newQty === null) return;
    const qty = parseInt(newQty);
    if (isNaN(qty) || qty < 0) {
        showToast('Invalid quantity', 'error');
        return;
    }
    if (qty === 0) {
        return deleteItem(itemId, 'this item');
    }
    const result = await api(`/api/inventory/${itemId}/update`, { quantity: qty });
    if (result?.ok) {
        showToast('Quantity updated', 'success');
        setTimeout(() => location.reload(), 300);
    }
}

async function deleteItem(itemId, name) {
    if (!confirm(`Remove ${name} from inventory?`)) return;
    const result = await api(`/api/inventory/${itemId}/delete`);
    if (result?.ok) {
        showToast(`${name} removed`, 'info');
        const el = document.querySelector(`[data-item-id="${itemId}"]`);
        if (el) {
            el.style.transition = 'opacity 0.3s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
        }
    }
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

async function saveNewCondition() {
    const effects = readEffectsJson('new-condition-effects');
    if (effects === null) return;

    const data = {
        name: document.getElementById('new-condition-name')?.value || '',
        description: document.getElementById('new-condition-desc')?.value || '',
        active: document.getElementById('new-condition-active')?.checked || false,
        effects,
    };

    if (!data.name) {
        showToast('Condition name is required', 'error');
        return;
    }

    const result = await api('/api/conditions/add', data);
    if (result?.ok) {
        showToast(`${data.name} added`, 'success');
        setTimeout(() => location.reload(), 300);
    }
}

async function toggleCondition(conditionId, active) {
    const result = await api(`/api/conditions/${conditionId}/update`, { active });
    if (result?.ok) {
        showToast(active ? 'Condition activated' : 'Condition deactivated', 'info');
        setTimeout(() => location.reload(), 300);
    }
}

async function deleteCondition(conditionId, name) {
    if (!confirm(`Remove ${name}?`)) return;
    const result = await api(`/api/conditions/${conditionId}/delete`);
    if (result?.ok) {
        showToast(`${name} removed`, 'info');
        setTimeout(() => location.reload(), 300);
    }
}


// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

let attacksData = []; // populated from page data
let editingAttackIndex = -1; // -1 = adding new

// Init attacks data from DOM
function initAttacksData() {
    attacksData = [];
    document.querySelectorAll('.attack-row').forEach(row => {
        const main = row.querySelector('.attack-row-main');
        const detail = row.querySelector('.attack-row-detail');
        // Read data from what's rendered — but we'll fetch fresh on edit
        attacksData.push(null); // placeholder — we'll always fetch fresh
    });
}

async function fetchAttacks() {
    const res = await fetch('/api/character/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})  // empty update just to get computed back
    });
    const json = await res.json();
    return json?.computed?.attacks || [];
}

function showAddAttackForm() {
    editingAttackIndex = -1;
    document.getElementById('atk-name').value = '';
    document.getElementById('atk-ability').value = 'str';
    document.getElementById('atk-bonus').value = '0';
    document.getElementById('atk-proficient').checked = true;
    document.getElementById('atk-damage-dice').value = '';
    document.getElementById('atk-damage-type').value = 'Slashing';
    document.getElementById('attack-form').classList.remove('hidden');
}

function editAttack(index) {
    editingAttackIndex = index;
    // Fetch current attacks to populate form
    fetch('/api/character/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    }).then(r => r.json()).then(json => {
        const attacks = json?.computed?.attacks || [];
        const atk = attacks[index];
        if (!atk) return;
        document.getElementById('atk-name').value = atk.name || '';
        document.getElementById('atk-ability').value = atk.ability || 'str';
        document.getElementById('atk-bonus').value = atk.bonus || 0;
        document.getElementById('atk-proficient').checked = atk.proficient !== false;
        document.getElementById('atk-damage-dice').value = atk.damage_dice || '';
        document.getElementById('atk-damage-type').value = atk.damage_type || 'Slashing';
        document.getElementById('attack-form').classList.remove('hidden');
    });
}

async function saveAttack() {
    const atk = {
        name: document.getElementById('atk-name')?.value || '',
        ability: document.getElementById('atk-ability')?.value || 'str',
        bonus: parseInt(document.getElementById('atk-bonus')?.value) || 0,
        proficient: document.getElementById('atk-proficient')?.checked ?? true,
        damage_dice: document.getElementById('atk-damage-dice')?.value || '',
        damage_type: document.getElementById('atk-damage-type')?.value || 'Slashing',
    };

    if (!atk.name) { showToast('Attack name is required', 'error'); return; }

    // Get current attacks from server
    const res = await fetch('/api/character/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const json = await res.json();
    const raw_attacks = json?.computed?.attacks || [];

    // Strip computed to_hit before saving back
    const attacks = raw_attacks.map(a => ({
        name: a.name, ability: a.ability, bonus: a.bonus,
        proficient: a.proficient, damage_dice: a.damage_dice, damage_type: a.damage_type
    }));

    if (editingAttackIndex >= 0 && editingAttackIndex < attacks.length) {
        attacks[editingAttackIndex] = atk;
    } else {
        attacks.push(atk);
    }

    const result = await api('/api/character/update', { attacks });
    if (result?.ok) {
        showToast(editingAttackIndex >= 0 ? 'Attack updated' : 'Attack added', 'success');
        cancelAttackForm();
        setTimeout(() => location.reload(), 300);
    }
}

async function deleteAttack(index) {
    if (!confirm('Remove this attack?')) return;

    const res = await fetch('/api/character/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const json = await res.json();
    const raw_attacks = json?.computed?.attacks || [];

    const attacks = raw_attacks.map(a => ({
        name: a.name, ability: a.ability, bonus: a.bonus,
        proficient: a.proficient, damage_dice: a.damage_dice, damage_type: a.damage_type
    }));

    attacks.splice(index, 1);

    const result = await api('/api/character/update', { attacks });
    if (result?.ok) {
        showToast('Attack removed', 'info');
        setTimeout(() => location.reload(), 300);
    }
}

function cancelAttackForm() {
    editingAttackIndex = -1;
    document.getElementById('attack-form').classList.add('hidden');
}


// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Initialize HP bar color
    if (document.getElementById('hp-bar')) {
        updateHPBar();
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });

    // Close modals with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
        }
    });
});
