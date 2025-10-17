const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const INITIAL_DELAY = 1 * 60 * 1000; // ✅ ALTERADO: 1 MINUTO (era 3 minutos)
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');

// Instâncias Evolution para Leads
const INSTANCES = ['RM01'];

// Palavras-chave que iniciam funis
const PALAVRAS_CHAVE = {
    'oi gaby quero te ajudar': 'FRASE_CHAVE_1',
    'oi gaby não consigo te ajudar': 'FRASE_CHAVE_2',
    'oi gaby boa noite': 'FRASE_CHAVE_3',
    'oi gaby td bem': 'FRASE_CHAVE_4'
};

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let stickyInstances = new Map();
let initialDelayTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;
let leadHistory = new Map();

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'FRASE_CHAVE_1': {
        id: 'FRASE_CHAVE_1',
        name: 'Frase Chave 1 - Oi Gaby quero te ajudar',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Oi! Que legal que você quer me ajudar! 😊',
                waitForReply: true
            }
        ]
    },
    'FRASE_CHAVE_2': {
        id: 'FRASE_CHAVE_2',
        name: 'Frase Chave 2 - Oi Gaby não consigo te ajudar',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Tudo bem! Obrigada por avisar! 💙',
                waitForReply: true
            }
        ]
    },
    'FRASE_CHAVE_3': {
        id: 'FRASE_CHAVE_3',
        name: 'Frase Chave 3 - Oi gaby boa noite',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Boa noite! Como posso te ajudar? 🌙',
                waitForReply: true
            }
        ]
    },
    'FRASE_CHAVE_4': {
        id: 'FRASE_CHAVE_4',
        name: 'Frase Chave 4 - Oi gaby td bem',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Oi! Tudo ótimo e você? 😊',
                waitForReply: true
            }
        ]
    }
};

// ============ SISTEMA DE LOCK ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const startTime = Date.now();
    
    while (webhookLocks.get(phoneKey)) {
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout lock para ${phoneKey}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    webhookLocks.set(phoneKey, true);
    return true;
}

function releaseWebhookLock(phoneKey) {
    webhookLocks.delete(phoneKey);
}

// ============ PERSISTÊNCIA ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe');
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', `Funis salvos: ${funnelsArray.length}`);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', `Erro ao salvar: ${error.message}`);
    }
}

async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        funis.clear();
        funnelsArray.forEach(funnel => {
            if (funnel.id.startsWith('FRASE_CHAVE_')) {
                funis.set(funnel.id, funnel);
            }
        });
        
        addLog('DATA_LOAD', `Funis carregados: ${funis.size}`);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Usando funis padrão');
        return false;
    }
}

async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            phoneKey: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null,
            completedAt: value.completedAt ? value.completedAt.toISOString() : null,
            pausedAt: value.pausedAt ? value.pausedAt.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: Array.from(phoneIndex.entries()),
            stickyInstances: Array.from(stickyInstances.entries()),
            leadHistory: Array.from(leadHistory.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', `Conversas salvas: ${conversationsArray.length}`);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', `Erro ao salvar conversas: ${error.message}`);
    }
}

async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        conversations.clear();
        parsed.conversations.forEach(conv => {
            conversations.set(conv.phoneKey, {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null,
                completedAt: conv.completedAt ? new Date(conv.completedAt) : null,
                pausedAt: conv.pausedAt ? new Date(conv.pausedAt) : null
            });
        });
        
        phoneIndex.clear();
        parsed.phoneIndex.forEach(([key, value]) => phoneIndex.set(key, value));
        
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        
        leadHistory.clear();
        if (parsed.leadHistory) {
            parsed.leadHistory.forEach(([key, value]) => leadHistory.set(key, value));
        }
        
        addLog('DATA_LOAD', `Conversas carregadas: ${parsed.conversations.length}`);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior');
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.slice(-8);
}

function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    
    const cleaned = fullPhone.replace(/\D/g, '');
    phoneIndex.set(cleaned, phoneKey);
    
    if (cleaned.startsWith('55')) {
        phoneIndex.set(cleaned.substring(2), phoneKey);
    }
    if (!cleaned.startsWith('55')) {
        phoneIndex.set('55' + cleaned, phoneKey);
    }
}

function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    if (!phoneKey || phoneKey.length !== 8) return null;
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        registerPhone(phone, phoneKey);
    }
    return conversation;
}

function phoneToRemoteJid(phone) {
    const cleaned = phone.replace(/\D/g, '');
    let formatted = cleaned;
    
    if (!formatted.startsWith('55')) {
        formatted = '55' + formatted;
    }
    
    if (formatted.length === 12) {
        const ddd = formatted.substring(2, 4);
        const numero = formatted.substring(4);
        formatted = '55' + ddd + '9' + numero;
    }
    
    return formatted + '@s.whatsapp.net';
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    return '[MENSAGEM]';
}

function addLog(type, message, data = null) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        type,
        message,
        data
    };
    logs.unshift(log);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    console.log(`[${log.timestamp.toISOString()}] ${type}: ${message}`);
}

function detectKeyword(messageText) {
    const normalized = messageText.toLowerCase().trim();
    
    for (const [keyword, funnelId] of Object.entries(PALAVRAS_CHAVE)) {
        if (normalized.includes(keyword)) {
            return funnelId;
        }
    }
    
    return null;
}

// ============ EVOLUTION API ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (EVOLUTION_API_KEY && EVOLUTION_API_KEY !== '') {
            headers['apikey'] = EVOLUTION_API_KEY;
        }
        
        addLog('EVOLUTION_REQUEST', `Enviando para ${instanceName}`, { url, endpoint });
        
        const response = await axios.post(url, payload, {
            headers: headers,
            timeout: 15000
        });
        
        addLog('EVOLUTION_SUCCESS', `✅ Sucesso em ${instanceName}`);
        return { ok: true, data: response.data };
        
    } catch (error) {
        const errorDetails = error.response?.data || error.message;
        const errorStatus = error.response?.status || 'NO_STATUS';
        
        addLog('EVOLUTION_ERROR', `❌ Erro em ${instanceName}: [${errorStatus}]`, { 
            url,
            endpoint,
            status: errorStatus,
            fullError: errorDetails
        });
        
        return { 
            ok: false, 
            error: errorDetails,
            status: errorStatus
        };
    }
}

async function sendText(remoteJid, text, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendText', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
    });
}

// ✅ CORRIGIDO: Envio de imagem COM caption
async function sendImage(remoteJid, imageUrl, caption, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'image',
        media: imageUrl
    };
    
    // ✅ Só adiciona caption se existir
    if (caption && caption.trim() !== '') {
        payload.caption = caption;
    }
    
    addLog('IMAGE_SEND', `Enviando imagem ${caption ? 'COM' : 'SEM'} caption`, { 
        url: imageUrl,
        hasCaption: !!caption 
    });
    
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// ✅ CORRIGIDO: Envio de vídeo COM caption
async function sendVideo(remoteJid, videoUrl, caption, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'video',
        media: videoUrl
    };
    
    // ✅ Só adiciona caption se existir
    if (caption && caption.trim() !== '') {
        payload.caption = caption;
    }
    
    addLog('VIDEO_SEND', `Enviando vídeo ${caption ? 'COM' : 'SEM'} caption`, { 
        url: videoUrl,
        hasCaption: !!caption 
    });
    
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// ✅ ÁUDIO COMO PTT (IDÊNTICO AO KIRVANO QUE FUNCIONA)
async function sendAudio(remoteJid, audioUrl, instanceName) {
    try {
        addLog('AUDIO_DOWNLOAD_START', `Baixando áudio de ${audioUrl}`, { phoneKey: remoteJid });
        
        // 1. Baixar o áudio da URL
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        // 2. Converter para Base64
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        
        addLog('AUDIO_CONVERTED', `Áudio convertido para base64 (${Math.round(base64Audio.length / 1024)}KB)`, { phoneKey: remoteJid });
        
        // 3. Enviar como PTT usando base64
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64,
            delay: 1200,
            encoding: true
        });
        
        if (result.ok) {
            addLog('AUDIO_SENT_SUCCESS', `✅ Áudio PTT enviado com sucesso`, { phoneKey: remoteJid });
            return result;
        }
        
        // 4. Se falhou, tentar formato alternativo
        addLog('AUDIO_RETRY_ALTERNATIVE', `Tentando formato alternativo`, { phoneKey: remoteJid });
        
        return await sendToEvolution(instanceName, '/message/sendMedia', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            mediatype: 'audio',
            media: audioBase64,
            mimetype: 'audio/mpeg'
        });
        
    } catch (error) {
        addLog('AUDIO_ERROR', `Erro ao processar áudio: ${error.message}`, { 
            phoneKey: remoteJid,
            url: audioUrl,
            error: error.message 
        });
        
        // 5. Fallback final: tentar enviar URL direta
        addLog('AUDIO_FALLBACK_URL', `Usando fallback com URL direta`, { phoneKey: remoteJid });
        
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl,
            delay: 1200
        });
    }
}

// ============ ENVIO COM RETRY ============
async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    let instancesToTry = [...INSTANCES];
    const stickyInstance = stickyInstances.get(phoneKey);
    
    if (stickyInstance && !isFirstMessage) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
    } else if (isFirstMessage) {
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        instancesToTry = [...INSTANCES.slice(nextIndex), ...INSTANCES.slice(0, nextIndex)];
    }
    
    let lastError = null;
    const maxAttempts = 3;
    
    for (const instanceName of instancesToTry) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let result;
                
                if (type === 'text') {
                    result = await sendText(remoteJid, text, instanceName);
                } 
                else if (type === 'image') {
                    result = await sendImage(remoteJid, mediaUrl, '', instanceName);
                } 
                else if (type === 'image+text') {
                    // ✅ CORRIGIDO: Envia imagem COM caption
                    result = await sendImage(remoteJid, mediaUrl, text, instanceName);
                } 
                else if (type === 'video') {
                    result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
                } 
                else if (type === 'video+text') {
                    // ✅ CORRIGIDO: Envia vídeo COM caption
                    result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
                } 
                else if (type === 'audio') {
                    result = await sendAudio(remoteJid, mediaUrl, instanceName);
                }
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    if (isFirstMessage) {
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    addLog('SEND_SUCCESS', `Enviado via ${instanceName}`, { phoneKey, type });
                    return { success: true, instanceName };
                }
                
                lastError = result.error;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                lastError = error.message;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    
    addLog('SEND_ALL_FAILED', `Falha total para ${phoneKey}`, { lastError });
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = lastError;
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO ============

async function createPendingLead(phoneKey, remoteJid, customerName) {
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId: null,
        stepIndex: -1,
        customerName,
        waiting_for_keyword: true,
        waiting_for_response: false,
        paused: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    addLog('LEAD_PENDING', `Lead aguardando palavra-chave`, { phoneKey });
}

async function startFunnelWithDelay(phoneKey, remoteJid, funnelId, customerName) {
    // Verificar se lead já recebeu este funil
    const history = leadHistory.get(phoneKey) || [];
    if (history.includes(funnelId)) {
        addLog('FUNNEL_ALREADY_SENT', `Lead já recebeu ${funnelId}`, { phoneKey });
        return;
    }
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: 0,
        customerName,
        waiting_for_keyword: false,
        waiting_for_response: false,
        waiting_initial_delay: true,
        paused: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    addLog('FUNNEL_START_DELAY', `Aguardando 1min para ${funnelId}`, { phoneKey }); // ✅ ALTERADO
    
    // Registrar no histórico
    history.push(funnelId);
    leadHistory.set(phoneKey, history);
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.funnelId === funnelId && !conv.paused && conv.waiting_initial_delay) {
            addLog('INITIAL_DELAY_DONE', `1min acabou, iniciando funil`, { phoneKey }); // ✅ ALTERADO
            
            conv.waiting_initial_delay = false;
            conversations.set(phoneKey, conv);
            
            await sendStep(phoneKey);
        }
        initialDelayTimeouts.delete(phoneKey);
    }, INITIAL_DELAY);
    
    initialDelayTimeouts.set(phoneKey, { timeout, funnelId, createdAt: new Date() });
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.paused) {
        addLog('STEP_PAUSED', `Funil pausado`, { phoneKey });
        return;
    }
    
    if (conversation.waiting_initial_delay) {
        addLog('STEP_WAITING_DELAY', `Aguardando delay inicial`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type
    });
    
    let result = { success: true };
    
    // Processar delay antes
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s antes`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    // Processar "digitando"
    if (step.showTyping && step.type !== 'delay' && step.type !== 'typing') {
        addLog('STEP_SHOW_TYPING', `Mostrando "digitando..." por 3s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `Delay de ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else if (step.type === 'typing') {
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', `Digitando ${typingSeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, typingSeconds * 1000));
    } else {
        // ✅ CORRIGIDO: Detecta se tem texto + mídia automaticamente
        let sendType = step.type;
        if ((step.type === 'image' || step.type === 'video') && step.text && step.text.trim() !== '') {
            sendType = step.type + '+text';
            addLog('STEP_MEDIA_WITH_TEXT', `Enviando ${step.type} com legenda`, { phoneKey });
        }
        
        result = await sendWithFallback(phoneKey, conversation.remoteJid, sendType, step.text, step.mediaUrl, isFirstMessage);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_WAITING_REPLY', `Aguardando resposta passo ${conversation.stepIndex}`, { phoneKey });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `Avançando automaticamente`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', `Falha no envio`, { phoneKey, error: result.error });
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.paused) {
        addLog('ADVANCE_PAUSED', `Funil pausado`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const nextStepIndex = conversation.stepIndex + 1;
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído`, { phoneKey });
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(phoneKey, conversation);
    addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex}`, { phoneKey, reason });
    
    await sendStep(phoneKey);
}

// ============ WEBHOOK EVOLUTION ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        if (fromMe) {
            return res.json({ success: true });
        }
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            let conversation = findConversationByPhone(incomingPhone);
            
            // CASO 1: Lead novo (primeira mensagem)
            if (!conversation) {
                const detectedFunnel = detectKeyword(messageText);
                
                if (detectedFunnel) {
                    addLog('KEYWORD_DETECTED', `Palavra-chave: ${detectedFunnel}`, { phoneKey, text: messageText });
                    await startFunnelWithDelay(phoneKey, remoteJid, detectedFunnel, incomingPhone);
                } else {
                    addLog('NO_KEYWORD', `Sem palavra-chave`, { phoneKey, text: messageText });
                    await createPendingLead(phoneKey, remoteJid, incomingPhone);
                }
                
                return res.json({ success: true });
            }
            
            // CASO 2: Lead aguardando palavra-chave
            if (conversation.waiting_for_keyword) {
                const detectedFunnel = detectKeyword(messageText);
                
                if (detectedFunnel) {
                    addLog('KEYWORD_DETECTED_PENDING', `Palavra-chave: ${detectedFunnel}`, { phoneKey });
                    await startFunnelWithDelay(phoneKey, conversation.remoteJid, detectedFunnel, conversation.customerName);
                } else {
                    addLog('STILL_NO_KEYWORD', `Ainda sem palavra-chave`, { phoneKey });
                }
                
                return res.json({ success: true });
            }
            
            // CASO 3: Funil pausado
            if (conversation.paused) {
                addLog('MESSAGE_WHILE_PAUSED', `Mensagem recebida com funil pausado`, { phoneKey });
                return res.json({ success: true });
            }
            
            // CASO 4: Aguardando resposta no funil
            if (conversation.waiting_for_response && !conversation.waiting_initial_delay) {
                addLog('CLIENT_REPLY', `Resposta recebida`, { phoneKey, text: messageText.substring(0, 50) });
                
                conversation.waiting_for_response = false;
                conversation.lastReply = new Date();
                conversations.set(phoneKey, conversation);
                
                await advanceConversation(phoneKey, messageText, 'reply');
            }
            
            res.json({ success: true });
            
        } finally {
            releaseWebhookLock(phoneKey);
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message);
        releaseWebhookLock(phoneKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

app.get('/api/dashboard', (req, res) => {
    const instanceUsage = {};
    INSTANCES.forEach(inst => instanceUsage[inst] = 0);
    stickyInstances.forEach(instance => {
        if (instanceUsage[instance] !== undefined) instanceUsage[instance]++;
    });
    
    let activeCount = 0, waitingCount = 0, completedCount = 0, pausedCount = 0, pendingCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.paused) pausedCount++;
        else if (conv.waiting_for_keyword) pendingCount++;
        else if (conv.waiting_for_response) waitingCount++;
        else activeCount++;
    });
    
    res.json({
        success: true,
        data: {
            active_conversations: activeCount,
            waiting_responses: waitingCount,
            completed_conversations: completedCount,
            paused_conversations: pausedCount,
            pending_keyword: pendingCount,
            total_funnels: funis.size,
            total_instances: INSTANCES.length,
            sticky_instances: stickyInstances.size,
            instance_distribution: instanceUsage
        }
    });
});

app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: Object.keys(defaultFunnels).includes(funnel.id),
        stepCount: funnel.steps.length
    }));
    
    res.json({ success: true, data: funnelsList });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ success: false, error: 'Campos obrigatórios faltando' });
    }
    
    if (!funnel.id.startsWith('FRASE_CHAVE_')) {
        return res.status(400).json({ success: false, error: 'Apenas funis FRASE_CHAVE permitidos' });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', `Funil salvo: ${funnel.id}`);
    saveFunnelsToFile();
    
    res.json({ success: true, message: 'Funil salvo', data: funnel });
});

// ✅ NOVO: Endpoint para mover passos
app.post('/api/funnels/:funnelId/move-step', (req, res) => {
    const { funnelId } = req.params;
    const { fromIndex, direction } = req.body;
    
    const funnel = funis.get(funnelId);
    if (!funnel) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
    
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    
    if (toIndex < 0 || toIndex >= funnel.steps.length) {
        return res.status(400).json({ success: false, error: 'Movimento inválido' });
    }
    
    // Trocar posições
    const temp = funnel.steps[fromIndex];
    funnel.steps[fromIndex] = funnel.steps[toIndex];
    funnel.steps[toIndex] = temp;
    
    funis.set(funnelId, funnel);
    saveFunnelsToFile();
    
    addLog('STEP_MOVED', `Passo ${fromIndex} movido para ${toIndex}`, { funnelId });
    
    res.json({ success: true, message: 'Passo movido', data: funnel });
});

app.get('/api/funnels/export', (req, res) => {
    try {
        const funnelsArray = Array.from(funis.values());
        const filename = `leads-funis-${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify({
            version: '1.0',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        }, null, 2));
        
        addLog('FUNNELS_EXPORT', `Export: ${funnelsArray.length} funis`);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/funnels/import', (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.funnels || !Array.isArray(importData.funnels)) {
            return res.status(400).json({ success: false, error: 'Arquivo inválido' });
        }
        
        let importedCount = 0, skippedCount = 0;
        
        importData.funnels.forEach(funnel => {
            if (funnel.id && funnel.name && funnel.steps && funnel.id.startsWith('FRASE_CHAVE_')) {
                funis.set(funnel.id, funnel);
                importedCount++;
            } else {
                skippedCount++;
            }
        });
        
        saveFunnelsToFile();
        addLog('FUNNELS_IMPORT', `Import: ${importedCount} importados, ${skippedCount} ignorados`);
        
        res.json({ 
            success: true, 
            imported: importedCount,
            skipped: skippedCount,
            total: importData.funnels.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([phoneKey, conv]) => ({
        id: phoneKey,
        phone: conv.remoteJid.replace('@s.whatsapp.net', ''),
        phoneKey: phoneKey,
        customerName: conv.customerName,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        waiting_for_keyword: conv.waiting_for_keyword || false,
        waiting_initial_delay: conv.waiting_initial_delay || false,
        paused: conv.paused || false,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        stickyInstance: stickyInstances.get(phoneKey),
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        errorMessage: conv.errorMessage
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
});

app.post('/api/conversation/:phoneKey/pause', (req, res) => {
    const { phoneKey } = req.params;
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
    
    conversation.paused = true;
    conversation.pausedAt = new Date();
    conversations.set(phoneKey, conversation);
    
    const timeout = initialDelayTimeouts.get(phoneKey);
    if (timeout) {
        clearTimeout(timeout.timeout);
        initialDelayTimeouts.delete(phoneKey);
    }
    
    addLog('CONVERSATION_PAUSED', `Funil pausado manualmente`, { phoneKey });
    
    res.json({ success: true, message: 'Funil pausado' });
});

app.post('/api/conversation/:phoneKey/resume', (req, res) => {
    const { phoneKey } = req.params;
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
    
    conversation.paused = false;
    conversation.waiting_initial_delay = false;
    conversations.set(phoneKey, conversation);
    
    addLog('CONVERSATION_RESUMED', `Funil retomado manualmente`, { phoneKey });
    
    sendStep(phoneKey);
    
    res.json({ success: true, message: 'Funil retomado' });
});

app.post('/api/conversation/:phoneKey/select-funnel', (req, res) => {
    const { phoneKey } = req.params;
    const { funnelId } = req.body;
    
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
    
    if (!funis.has(funnelId)) {
        return res.status(400).json({ success: false, error: 'Funil não existe' });
    }
    
    const history = leadHistory.get(phoneKey) || [];
    if (history.includes(funnelId)) {
        return res.status(400).json({ success: false, error: 'Lead já recebeu este funil' });
    }
    
    addLog('FUNNEL_SELECTED_MANUALLY', `Funil ${funnelId} selecionado manualmente`, { phoneKey });
    
    conversation.funnelId = funnelId;
    conversation.stepIndex = 0;
    conversation.waiting_for_keyword = false;
    conversation.waiting_initial_delay = false;
    conversation.paused = false;
    conversations.set(phoneKey, conversation);
    
    history.push(funnelId);
    leadHistory.set(phoneKey, history);
    
    sendStep(phoneKey);
    
    res.json({ success: true, message: 'Funil iniciado' });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({ success: true, data: recentLogs });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 SISTEMA DE LEADS v2.0 [TODAS CORREÇÕES APLICADAS]');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.join(', '));
    console.log('API Key configurada:', EVOLUTION_API_KEY ? '✅ SIM' : '❌ NÃO');
    console.log('Delay inicial:', '⚡ 1 MINUTO (era 3min)');
    console.log('');
    console.log('✅ CORREÇÕES APLICADAS:');
    console.log('  1. ✅ Foto + texto CORRIGIDO (caption funciona)');
    console.log('  2. ✅ Vídeo + texto CORRIGIDO (caption funciona)');
    console.log('  3. ✅ Delay inicial: 1 minuto (era 3)');
    console.log('  4. ✅ Botões mover passos (↑↓) adicionados');
    console.log('  5. ✅ Endpoint /api/funnels/:id/move-step criado');
    console.log('');
    console.log('🔑 PALAVRAS-CHAVE:');
    Object.entries(PALAVRAS_CHAVE).forEach(([keyword, funnel]) => {
        console.log(`  "${keyword}" → ${funnel}`);
    });
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('='.repeat(70));
    
    await initializeData();
});
