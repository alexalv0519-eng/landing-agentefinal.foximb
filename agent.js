/**
 * agent.js — Motor del Asesor Jurídico y Comercial IA.
 *
 * - Conecta con Gemini (gemini-2.5-flash) cuando hay API Key en localStorage.
 * - Sin clave, ejecuta un Modo Demo determinista con las reglas de los skills.
 * - No usa build tools: funciona como script clásico en cualquier landing.
 */
(function () {
  'use strict';

  var P = window.AGENT_PROMPTS;

  if (!P) {
    console.error('[Agente IA] Falta prompts.js. Cárgalo antes de agent.js.');
    return;
  }

  var C = P.CONFIG;
  var CONTACTO = {
    email: 'ealvarez@unilasallista.edu.co',
    phone: '573136001036',
    storageKey: 'agente-ia-contactos'
  };
  var $ = function (id) { return document.getElementById(id); };
  var dom = {};

  var state = {
    key: '',
    flow: 'general',
    messages: [],
    demo: null,
    busy: false,
    pdfPromise: null,
    lastFile: null,
    toastTimer: null
  };

  /* =========================================================
     Utilidades
     ========================================================= */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatCOP(value) {
    var n = Number(value) || 0;
    return '$' + Math.round(n).toLocaleString('es-CO');
  }

  function parseCOP(value) {
    var s = String(value == null ? '' : value).toLowerCase();
    var scaled = s.match(/(\d+(?:[.,]\d+)?)\s*(mil\s*millones|millones|m\b)/);
    if (scaled) {
      var amount = parseFloat(scaled[1].replace(',', '.'));
      return Math.round(amount * (/mil millones/.test(scaled[2]) ? 1e9 : 1e6));
    }
    var numeric = s.match(/\d[\d.,]*/);
    if (!numeric) return 0;
    var digits = numeric[0].replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  function todayCOP() {
    return new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function safeReadKey() {
    try { return String(localStorage.getItem(C.storageKey) || '').trim(); }
    catch (e) { return ''; }
  }

  // Regla única de validez: se aplica al guardar, al arrancar y al decidir
  // si el asesor está en Modo Online o en Modo Demo.
  function isValidApiKey(value) {
    var apiKey = String(value == null ? '' : value).trim();
    return apiKey !== '' && (apiKey.startsWith('AIza') || apiKey.startsWith('AQ.'));
  }

  function isOnline() {
    return isValidApiKey(state.key);
  }

  function safeWriteKey(value) {
    try { localStorage.setItem(C.storageKey, value); return true; }
    catch (e) { return false; }
  }

  function safeRemoveKey() {
    try { localStorage.removeItem(C.storageKey); return true; }
    catch (e) { return false; }
  }

  function toast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 3600);
  }

  /* =========================================================
     Render de Markdown (escape seguro, sin HTML del usuario)
     ========================================================= */

  function inlineMarkdown(source) {
    var stored = [];
    var text = String(source == null ? '' : source);

    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      stored.push(code);
      return '\u0001' + (stored.length - 1) + '\u0001';
    });

    text = escapeHtml(text);

    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, href) {
      return '<a href="' + href.replace(/&amp;/g, '&') + '" target="_blank" rel="noopener">' + label + '</a>';
    });
    text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>');
    text = text.replace(/\u0001(\d+)\u0001/g, function (_, index) {
      return '<code>' + escapeHtml(stored[Number(index)]) + '</code>';
    });

    return text;
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (cell) {
      return cell.trim();
    });
  }

  function isTableHeader(lines, index) {
    return /^\s*\|/.test(lines[index] || '') &&
      /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[index + 1] || '') &&
      /-/.test(lines[index + 1] || '');
  }

  function semaforoFor(content) {
    if (/🔴|rojo/i.test(content)) return 'semaforo-rojo';
    if (/🟡|amarillo/i.test(content)) return 'semaforo-amarillo';
    if (/🟢|verde/i.test(content)) return 'semaforo-verde';
    return null;
  }

  function startsBlock(lines, index) {
    var line = lines[index] || '';
    return /^\s*```/.test(line) ||
      /^#{1,4}\s+/.test(line) ||
      /^\s*[-*•]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*(---+|\*\*\*+)\s*$/.test(line) ||
      isTableHeader(lines, index);
  }

  function renderMarkdown(source) {
    var lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      if (/^\s*```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }

      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        var level = Math.min(heading[1].length + 2, 6);
        var content = heading[2];
        var semaforo = semaforoFor(content);
        if (semaforo) {
          out.push('<div class="semaforo ' + semaforo + '">' + inlineMarkdown(content) + '</div>');
        } else {
          out.push('<h' + level + '>' + inlineMarkdown(content) + '</h' + level + '>');
        }
        i++;
        continue;
      }

      if (isTableHeader(lines, i)) {
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push('<table><thead><tr>' + head.map(function (cell) {
          return '<th>' + inlineMarkdown(cell) + '</th>';
        }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
          return '<tr>' + row.map(function (cell) {
            return '<td>' + inlineMarkdown(cell) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>');
        continue;
      }

      var unordered = line.match(/^\s*[-*•]\s+(.*)$/);
      var ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (unordered || ordered) {
        var tag = unordered ? 'ul' : 'ol';
        var pattern = unordered ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
        var items = [];
        while (i < lines.length) {
          var match = lines[i].match(pattern);
          if (!match) break;
          items.push('<li>' + inlineMarkdown(match[1]) + '</li>');
          i++;
        }
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + inlineMarkdown(quote.join(' ')) + '</blockquote>');
        continue;
      }

      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      var paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        paragraph.push(lines[i]);
        i++;
      }
      out.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>');
    }

    return out.join('');
  }

  /* =========================================================
     Mensajes
     ========================================================= */

  function addMessage(role, text, options) {
    options = options || {};
    state.messages.push({
      role: role,
      text: String(text || ''),
      downloadable: !!options.downloadable,
      filename: options.filename || 'documento.md',
      action: options.action || null,
      suggestions: options.suggestions || []
    });
    renderMessages();
  }

  function renderMessages() {
    dom.messages.innerHTML = '';

    state.messages.forEach(function (message, index) {
      var row = document.createElement('div');
      row.className = 'msg ' + (message.role === 'user' ? 'user' : 'assistant');

      if (message.role === 'assistant') {
        var avatar = document.createElement('span');
        avatar.className = 'msg-avatar';
        avatar.textContent = 'IA';
        row.appendChild(avatar);
      }

      var bubble = document.createElement('div');
      bubble.className = 'msg-bubble md';
      bubble.innerHTML = message.role === 'user'
        ? inlineMarkdown(message.text)
        : renderMarkdown(message.text);
      row.appendChild(bubble);

      if (message.role === 'assistant') {
        var actions = document.createElement('div');
        actions.className = 'msg-actions';
        var extraAction = message.action
          ? '<button class="msg-action msg-action-primary" data-action="' + escapeHtml(message.action.type) + '" data-index="' + index + '">' + escapeHtml(message.action.label) + '</button>'
          : '';
        actions.innerHTML = '<button class="msg-action" data-action="copy" data-index="' + index + '">Copiar</button>' +
          (message.downloadable ? '<button class="msg-action" data-action="download" data-index="' + index + '">Descargar .md</button>' : '') +
          extraAction;
        row.appendChild(actions);
      }

      if (message.suggestions && message.suggestions.length) {
        var chips = document.createElement('div');
        chips.className = 'suggestion-chips';
        message.suggestions.forEach(function (suggestion) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'suggestion-chip';
          chip.setAttribute('data-action', 'flow');
          chip.setAttribute('data-flow', suggestion.flow);
          chip.setAttribute('data-index', index);
          chip.textContent = '→ ' + suggestion.label;
          chips.appendChild(chip);
        });
        row.appendChild(chips);
      }

      dom.messages.appendChild(row);
    });

    scrollToBottom();
  }

  function scrollToBottom() {
    if (dom.messages) dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function setBusy(value) {
    state.busy = value;
    dom.send.disabled = value;
    dom.typing.hidden = !value;
    if (!value) scrollToBottom();
  }

  /* =========================================================
     Gemini
     ========================================================= */

  function codigosTexto() {
    var self = P.AUDITORIA_CODIGOS;
    return Object.keys(self).map(function (code) {
      var item = self[code];
      return code + ' — ' + item.titulo + ' [' + item.nivel + ']. ' + item.implica + ' Saneamiento: ' + item.saneamiento;
    }).join('\n');
  }

  function plantillasTexto() {
    return '### templates/oferta-comercial-compra.md\n' + P.TEMPLATES.ofertaCompra +
      '\n\n### templates/solicitud-estudio-arrendamiento.md\n' + P.TEMPLATES.solicitudArriendo;
  }

  function systemPromptFor(flow) {
    var base = P.SYSTEM_PROMPTS.base || '';
    var module = (flow && flow !== 'base') ? P.SYSTEM_PROMPTS[flow] : '';
    var prompt = module
      ? base + '\n\n---\n\nMÓDULO ESPECIALIZADO ACTIVO: ' + (P.FLOW_LABELS[flow] || flow) + '\n\n' + module
      : base;
    return prompt
      .replace('{{CODIGOS}}', codigosTexto())
      .replace('{{PLANTILLAS}}', plantillasTexto());
  }

  function buildContents() {
    var contents = [];
    state.messages.forEach(function (message) {
      if (message.role !== 'user' && message.role !== 'assistant') return;
      var role = message.role === 'user' ? 'user' : 'model';
      var last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts[0].text += '\n\n' + message.text;
      } else {
        contents.push({ role: role, parts: [{ text: message.text }] });
      }
    });
    return contents;
  }

  function apiError(status, code, message) {
    var error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  function requestGemini(model) {
    var url = C.apiBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(state.key);
    var payload = {
      system_instruction: { parts: [{ text: systemPromptFor(state.flow) }] },
      contents: buildContents(),
      generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 4096 }
    };

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 90000) : null;

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) {
            // Mensaje exacto devuelto por Gemini, sin reescrituras genéricas.
            var detail = (data && data.error && data.error.message) || ('HTTP ' + response.status);
            var code = 'API';
            if (response.status === 400 || response.status === 403 ||
                /API key|API_KEY|expired|unauthoriz|not valid/i.test(detail)) {
              code = 'AUTH';
            } else if (response.status === 429) {
              code = 'QUOTA';
            }
            throw apiError(response.status, code, detail);
          }
          return data;
        });
      })
      .then(function (json) {
        if (json.promptFeedback && json.promptFeedback.blockReason) {
          throw new Error('La solicitud fue bloqueada (' + json.promptFeedback.blockReason + '). Reformula la consulta.');
        }
        var candidate = json.candidates && json.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
          throw new Error('El modelo no devolvió una respuesta. Intenta de nuevo.');
        }
        return candidate.content.parts.map(function (part) { return part.text || ''; }).join('').trim();
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('La solicitud tardó demasiado. Intenta de nuevo.');
        }
        if (error instanceof TypeError) {
          throw new Error('No hay conexión con la API de Gemini. Revisa tu red o usa el Modo Demo.');
        }
        throw error;
      })
      .then(function (result) {
        if (timeout) clearTimeout(timeout);
        return result;
      }, function (error) {
        if (timeout) clearTimeout(timeout);
        throw error;
      });
  }

  function callGemini() {
    return requestGemini(C.model);
  }

  /* =========================================================
     Modo Demo — calculadora
     ========================================================= */

  function closingEstimate(data) {
    var valor = data.valor;
    var vis = !!data.vis;
    var credito = !!data.credito;
    var pct = data.pct || (vis ? 0.8 : 0.7);

    var financiado = credito ? valor * pct : 0;
    var cuotaInicial = valor - financiado;

    var honorarios = valor * (vis ? 0.0025 : 0.003);
    var iva = honorarios * 0.19;
    var copias = vis ? 300000 : 450000;
    var notarialTotal = honorarios + iva + copias;
    var notarialComprador = notarialTotal / 2;
    var notarialVendedor = notarialTotal / 2;

    var hipoteca = credito ? financiado * 0.003 * (vis ? 0.30 : 0.50) : 0;
    var retencion = valor * 0.01;
    var beneficencia = valor * (vis ? 0.005 : 0.01) + (credito ? financiado * 0.005 : 0);
    var oripRate = vis ? 0.004 : (valor >= 800000000 ? 0.007 : (valor >= 200000000 ? 0.006 : 0.005));
    var orip = valor * oripRate;

    var totalComprador = cuotaInicial + notarialComprador + hipoteca + beneficencia + orip;
    var netoVendedor = valor - retencion - notarialVendedor;

    var monthlyRate = Math.pow(1.12, 1 / 12) - 1;
    function cuota(principal, years) {
      var n = years * 12;
      return principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -n));
    }

    var rows = [
      ['Cuota inicial / precio de contado', formatCOP(valor), credito ? Math.round((1 - pct) * 100) + '%' : '100%', formatCOP(cuotaInicial), 'Comprador'],
      ['Derechos notariales + IVA + copias', formatCOP(valor), (vis ? '0,25%' : '0,30%') + ' + IVA 19%', formatCOP(notarialTotal), '50% Comprador / 50% Vendedor'],
      ['Retención en la fuente', formatCOP(valor), '1%', formatCOP(retencion), 'Vendedor'],
      ['Beneficencia / boleta fiscal', formatCOP(valor), (vis ? '0,5%' : '1%') + (credito ? ' + 0,5% crédito' : ''), formatCOP(beneficencia), 'Comprador'],
      ['Derechos de registro (ORIP)', formatCOP(valor), (oripRate * 100).toFixed(1) + '%', formatCOP(orip), 'Comprador']
    ];
    if (credito) {
      rows.push(['Constitución de hipoteca', formatCOP(financiado), '0,30% c/ reducción ' + (vis ? '70%' : '50%'), formatCOP(hipoteca), 'Comprador']);
    }

    var md = [
      '## Resumen ejecutivo',
      '',
      '- **Total efectivo requerido por el Comprador: ' + formatCOP(totalComprador) + '**',
      '- **Neto aproximado a recibir por el Vendedor: ' + formatCOP(netoVendedor) + '**',
      '',
      '### Liquidación referencial',
      '',
      '| Rubro | Base | Tarifa aplicada | Valor estimado | Asume |',
      '|---|---|---|---|---|'
    ];
    rows.forEach(function (row) {
      md.push('| ' + row.join(' | ') + ' |');
    });

    md.push('');
    if (credito) {
      md.push('### Proyección financiera');
      md.push('');
      md.push('- Monto a financiar: **' + formatCOP(financiado) + '** (' + Math.round(pct * 100) + '%).');
      md.push('- Cuota inicial: **' + formatCOP(cuotaInicial) + '**.');
      md.push('- Cuota referencial a 15 años: **' + formatCOP(cuota(financiado, 15)) + '/mes**.');
      md.push('- Cuota referencial a 20 años: **' + formatCOP(cuota(financiado, 20)) + '/mes**.');
      md.push('');
      md.push('> Tasa efectiva anual ilustrativa del 12%. La tasa real depende de la entidad financiera y del perfil crediticio.');
      md.push('');
    }

    md.push('> Estimaciones referenciales sujetas a las tarifas vigentes de la Superintendencia de Notariado y Registro (SNR) y al avalúo catastral. Valida la liquidación exacta con la notaría.');
    md.push('');
    md.push('¿Deseas que prepare una **oferta de compra** con estos valores o agendemos una asesoría para revisar el predio?');

    var text = md.join('\n');
    return { text: text, file: { name: 'liquidacion-cierre-inmobiliario.md', content: text } };
  }

  function demoCalculadora(text, demo) {
    if (demo.step === 0) {
      var valor = parseCOP(text);
      if (!valor || valor < 1000000) {
        return { text: 'No pude identificar el valor. Escríbelo así: **450.000.000** o **450 millones**.' };
      }
      demo.data.valor = valor;
      demo.step = 1;
      return { text: 'Valor registrado: **' + formatCOP(valor) + '**.\n\n¿Es **VIS**, **No VIS**, comercial o lote?' };
    }

    if (demo.step === 1) {
      var noVis = /no\s*vis|novis|comercial|lote|oficina|bodega/i.test(text);
      var vis = !noVis && /vis/i.test(text);
      demo.data.vis = vis;
      demo.step = 2;
      return { text: 'Tipo registrado: **' + (vis ? 'VIS' : 'No VIS / comercial') + '**.\n\n¿Pago **de contado** o con **crédito hipotecario / leasing**? Si es crédito, indica el porcentaje a financiar (ej. 70%).' };
    }

    if (demo.step === 2) {
      var credito = /cr[eé]dito|hipotec|leasing|financ/i.test(text);
      var percent = text.match(/(\d{1,3})\s*%/);
      var pct = percent ? parseInt(percent[1], 10) / 100 : (demo.data.vis ? 0.8 : 0.7);
      pct = Math.max(0.1, Math.min(0.95, pct));
      demo.data.credito = credito;
      demo.data.pct = pct;
      demo.step = 3;
      return closingEstimate(demo.data);
    }

    return closingEstimate(demo.data);
  }

  /* =========================================================
     Modo Demo — auditoría de tradición
     ========================================================= */

  var KEYWORD_FALLBACK = [
    { re: /EMBARGO|COACTIVO/i, code: '0427' },
    { re: /DEMANDA|REIVINDICATORIO|PERTENENCIA/i, code: '0415' },
    { re: /FALSA TRADICI[OÓ]N|DERECHOS Y ACCIONES/i, code: '0601' },
    { re: /HIPOTECA/i, code: '0204' },
    { re: /AFECTACI[OÓ]N A VIVIENDA FAMILIAR/i, code: '0304' },
    { re: /PATRIMONIO DE FAMILIA/i, code: '0315' },
    { re: /USUFRUTO/i, code: '0307' },
    { re: /COMPRAVENTA|ESCRITURA PUBLICA/i, code: '0125' }
  ];

  function evaluateTradition(raw) {
    var text = String(raw || '');
    var upper = text.toUpperCase();
    var found = [];
    var regex = /\b0\d{3}\b/g;
    var match;

    while ((match = regex.exec(upper)) !== null) {
      if (P.AUDITORIA_CODIGOS[match[0]] && found.indexOf(match[0]) === -1) found.push(match[0]);
    }
    if (!found.length) {
      KEYWORD_FALLBACK.forEach(function (item) {
        if (item.re.test(upper) && found.indexOf(item.code) === -1) found.push(item.code);
      });
    }

    var level = 'Amarillo';
    if (found.some(function (code) { return P.AUDITORIA_CODIGOS[code].nivel === 'Rojo'; })) level = 'Rojo';
    else if (!found.length) level = 'Amarillo';
    else if (found.every(function (code) { return P.AUDITORIA_CODIGOS[code].nivel === 'Verde'; })) level = 'Verde';

    var emoji = level === 'Rojo' ? '🔴' : level === 'Amarillo' ? '🟡' : '🟢';
    var synthesis = level === 'Rojo'
      ? 'Existen bloqueos registrales que impiden escriturar sin saneamiento previo.'
      : level === 'Amarillo'
        ? 'Hay gravámenes o limitaciones subsanables antes o durante la escritura.'
        : 'La cadena de titularidad parece saneada; confirma con estudio de títulos.';

    var matricula = text.match(/(?:MATR[IÍ]CULA|MATR[IÍ]CULA INMOBILIARIA)[^\d]{0,25}(\d{1,2}[-\s]?\d{3,8})/i);

    var md = [
      '## ' + emoji + ' ' + level.toUpperCase() + ' — ' + synthesis,
      ''
    ];
    if (matricula) md.push('**Matrícula identificada:** ' + matricula[1] + '.');
    md.push('');
    md.push('### Hallazgos del certificado');
    md.push('');
    md.push('| Código | Acto registral | Nivel | Qué implica | Saneamiento |');
    md.push('|---|---|---|---|---|');

    if (!found.length) {
      md.push('| — | No se identificaron códigos registrales | 🟡 Amarillo | El texto no permite una conclusión | Solicita revisión manual del certificado |');
    } else {
      found.forEach(function (code) {
        var item = P.AUDITORIA_CODIGOS[code];
        var badge = item.nivel === 'Rojo' ? '🔴 Rojo' : item.nivel === 'Amarillo' ? '🟡 Amarillo' : '🟢 Verde';
        md.push('| ' + code + ' | ' + item.titulo + ' | ' + badge + ' | ' + item.implica + ' | ' + item.saneamiento + ' |');
      });
    }

    md.push('');
    md.push('### Ruta de saneamiento');
    md.push('');
    var seen = [];
    found.forEach(function (code) {
      var saneamiento = P.AUDITORIA_CODIGOS[code].saneamiento;
      if (seen.indexOf(saneamiento) === -1) seen.push(saneamiento);
    });
    if (!seen.length) seen.push('Obtén un certificado de tradición legible e identifica los códigos registrales de cada acto.');
    seen.forEach(function (step, index) {
      md.push((index + 1) + '. ' + step);
    });

    md.push('');
    if (level === 'Rojo') {
      md.push('**Recomendación comercial:** suspender la separación del inmueble y no firmar promesa hasta completar el saneamiento.');
    } else if (level === 'Amarillo') {
      md.push('**Recomendación comercial:** condicionar la promesa de compraventa a la cancelación de los gravámenes identificados.');
    } else {
      md.push('**Recomendación comercial:** avanzar a estudio de títulos formal antes de la escrituración.');
    }
    md.push('');
    md.push('> Análisis referencial basado en los códigos SNR detectados. No sustituye el estudio de títulos realizado por la notaría.');
    md.push('');
    md.push('Puedes pegar otro certificado o pedirme que prepare una oferta condicionada al saneamiento.');

    var text = md.join('\n');
    return { text: text, file: { name: 'informe-auditoria-tradicion.md', content: text } };
  }

  function demoAuditoria(text, demo) {
    var clean = String(text || '').trim();
    if (clean.length < 40 && !/\b0\d{3}\b/.test(clean)) {
      return { text: 'Pega el texto del certificado (o sube un `.txt`/`.pdf` con el clip 📎) para evaluar el semáforo jurídico.' };
    }
    demo.step = 1;
    return evaluateTradition(clean);
  }

  /* =========================================================
     Modo Demo — match y generación documental (sin inventario)
     ========================================================= */

  var COMPRA_FIELDS = [
    { key: 'nombre', aliases: ['nombre completo', 'nombre'] },
    { key: 'cedula', aliases: ['cédula', 'cedula', 'cc', 'documento'] },
    { key: 'correo', aliases: ['correo', 'email'] },
    { key: 'telefono', aliases: ['teléfono', 'telefono', 'celular', 'móvil', 'movil'] },
    { key: 'valor', aliases: ['valor ofertado', 'valor', 'precio'] },
    { key: 'forma', aliases: ['forma de pago', 'pago'] },
    { key: 'arras', aliases: ['arras', 'separación', 'separacion'] },
    { key: 'fecha', aliases: ['fecha estimada', 'fecha de firma', 'fecha'] },
    { key: 'direccion', aliases: ['dirección', 'direccion', 'inmueble'] },
    { key: 'matricula', aliases: ['matrícula', 'matricula'] },
    { key: 'municipio', aliases: ['municipio', 'ciudad'] },
    { key: 'destino', aliases: ['destino', 'destinación', 'destinacion'] },
    { key: 'propietario', aliases: ['propietario'] }
  ];

  var ARRIENDO_FIELDS = [
    { key: 'nombre', aliases: ['nombre completo', 'nombre'] },
    { key: 'cedula', aliases: ['cédula', 'cedula', 'cc', 'documento'] },
    { key: 'actividad', aliases: ['actividad económica', 'actividad economica', 'actividad'] },
    { key: 'ingresos', aliases: ['ingresos mensuales', 'ingresos'] },
    { key: 'ocupantes', aliases: ['personas y mascotas', 'ocupantes', 'mascotas'] },
    { key: 'respaldo', aliases: ['perfil de respaldo', 'respaldo', 'codeudor'] },
    { key: 'canon', aliases: ['canon mensual', 'canon'] },
    { key: 'administracion', aliases: ['administración', 'administracion', 'administracion estimada'] },
    { key: 'direccion', aliases: ['dirección', 'direccion', 'inmueble'] },
    { key: 'municipio', aliases: ['municipio', 'ciudad'] },
    { key: 'observaciones', aliases: ['observaciones'] }
  ];

  function fieldsFor(type) {
    return type === 'compra' ? COMPRA_FIELDS : ARRIENDO_FIELDS;
  }

  function parseFields(text, definitions) {
    var values = {};
    definitions.forEach(function (field) {
      field.aliases.forEach(function (alias) {
        if (values[field.key]) return;
        var regex = new RegExp(escapeRegExp(alias) + '\\s*[:\\-]?\\s*([^\\n,;]+)', 'i');
        var match = String(text).match(regex);
        if (match && match[1].trim()) values[field.key] = match[1].trim();
      });
    });
    return values;
  }

  function fillTemplate(template, map) {
    return String(template).replace(/\{\{([A-Z_]+)\}\}/g, function (_, key) {
      var value = map[key];
      return value === undefined || value === null || value === '' ? 'Por confirmar' : String(value);
    });
  }

  function missingPoints(map) {
    return Object.keys(map).filter(function (key) {
      return map[key] === 'Por confirmar';
    });
  }

  function buildDocument(type, values) {
    var v = values || {};
    var ciudad = v.ciudad || 'Medellín, ' + todayCOP();
    var doc;
    var map;

    if (type === 'compra') {
      map = {
        CIUDAD_FECHA: ciudad,
        DIRECCION_INMUEBLE: v.direccion,
        MATRICULA: v.matricula,
        MUNICIPIO: v.municipio,
        NOMBRE_COMPLETO: v.nombre,
        CEDULA: v.cedula,
        CORREO: v.correo,
        TELEFONO: v.telefono,
        DESTINACION: v.destino || 'vivienda',
        VALOR_OFERTA: v.valor ? formatCOP(parseCOP(v.valor)) : '',
        FORMA_PAGO: v.forma,
        ARRAS: v.arras ? formatCOP(parseCOP(v.arras)) : '',
        FECHA_PROMESA: v.fecha,
        VIGENCIA: v.vigencia || '5 días hábiles',
        NOMBRE_PROPIETARIO: v.propietario
      };
      doc = fillTemplate(P.TEMPLATES.ofertaCompra, map);
    } else {
      var canon = parseCOP(v.canon);
      var admin = parseCOP(v.administracion);
      var ingresos = parseCOP(v.ingresos);
      var total = canon + admin;
      var requerido = 2 * total;
      var resultado;
      if (!canon || !ingresos) resultado = 'Por confirmar (se requieren canon e ingresos)';
      else if (ingresos >= requerido) resultado = 'PRE-APROBADO — ingresos >= 2 × (canon + administración)';
      else resultado = 'REQUIERE RESPALDO ADICIONAL — ingresos por debajo de 2 × (canon + administración)';

      map = {
        CIUDAD_FECHA: ciudad,
        DIRECCION_INMUEBLE: v.direccion,
        MUNICIPIO: v.municipio,
        NOMBRE_COMPLETO: v.nombre,
        CEDULA: v.cedula,
        ACTIVIDAD_ECONOMICA: v.actividad,
        INGRESOS_MENSUALES: ingresos ? formatCOP(ingresos) : '',
        OCUPANTES_MASCOTAS: v.ocupantes,
        RESPALDO: v.respaldo,
        CANON: canon ? formatCOP(canon) : '',
        ADMINISTRACION: v.administracion ? formatCOP(admin) : '',
        TOTAL_MENSUAL: total ? formatCOP(total) : '',
        INGRESOS_REQUERIDOS: total ? formatCOP(requerido) : '',
        RESULTADO_PREAPROBACION: resultado,
        OBSERVACIONES: v.observaciones || 'Sin observaciones adicionales.'
      };
      doc = fillTemplate(P.TEMPLATES.solicitudArriendo, map);
    }

    var pending = missingPoints(map).filter(function (key) {
      return key !== 'RESULTADO_PREAPROBACION' && key !== 'OBSERVACIONES';
    });
    if (pending.length) {
      doc += '\n\n## Puntos por confirmar\n\n';
      pending.forEach(function (key) {
        doc += '- ' + key.replace(/_/g, ' ').toLowerCase() + '\n';
      });
    }
    doc += '\n\n> No se ha recomendado ningún inmueble: este despliegue no tiene catálogo cargado y el agente no inventa propiedades.';

    return doc;
  }

  function askDocumentFields(type) {
    if (type === 'compra') {
      return 'Para la **Oferta Comercial de Compra**, envíame en una sola respuesta:\n\n' +
        '- Nombre completo y cédula\n- Correo y teléfono\n- Valor ofertado y forma de pago\n- Arras propuestas y fecha estimada de firma\n- Dirección, matrícula y municipio (si los tienes)\n\n' +
        'Ejemplo: `Nombre: Juan Pérez, Cédula: 1.234.567, Correo: juan@correo.com, Valor ofertado: 450 millones, ...`';
    }
    return 'Para la **Solicitud de Estudio de Arrendamiento**, envíame en una sola respuesta:\n\n' +
      '- Nombre completo y cédula\n- Actividad económica e ingresos mensuales\n- Personas y mascotas\n- Respaldo (codeudor con finca raíz o póliza)\n- Canon y administración\n\n' +
      'Ejemplo: `Nombre: Juan Pérez, Ingresos: 8.000.000, Canon: 3.200.000, Administración: 450.000, Respaldo: póliza ...`';
  }

  function demoMatch(text, demo) {
    var clean = String(text || '').trim();
    var lower = clean.toLowerCase();

    if (demo.step === 0) {
      var operation = null;
      if (/arriend|alquil|arrend|canon/.test(lower)) operation = 'arriendo';
      else if (/compr|ofert|compraventa/.test(lower)) operation = 'compra';

      demo.data.tipo = operation;
      demo.data.perfil = clean;
      demo.data.values = parseFields(clean, COMPRA_FIELDS.concat(ARRIENDO_FIELDS));
      demo.step = operation ? 2 : 1;

      var prefix = '**Perfil registrado**\n\n> ' + clean.replace(/\n/g, ' ') + '\n\n' +
        '> No contamos con un catálogo de inmuebles en esta demo, por lo que **no recomendaré ni inventaré propiedades**. Generaremos el borrador con tus datos.\n\n';

      if (operation) return { text: prefix + askDocumentFields(operation) };
      return { text: prefix + '¿Generamos una **Oferta de Compra** o una **Solicitud de Arrendamiento**?' };
    }

    if (demo.step === 1) {
      if (/arriend|arrend|alquil|solicitud/.test(lower)) demo.data.tipo = 'arriendo';
      else if (/compr|oferta|compraventa/.test(lower)) demo.data.tipo = 'compra';
      else return { text: 'Indica si deseas **oferta de compra** o **solicitud de arriendo**.' };
      demo.step = 2;
      return { text: askDocumentFields(demo.data.tipo) };
    }

    var fields = parseFields(clean, fieldsFor(demo.data.tipo || 'compra'));
    demo.data.values = Object.assign({}, demo.data.values || {}, fields);
    demo.step = 3;

    var type = demo.data.tipo || 'compra';
    var doc = buildDocument(type, demo.data.values);
    var filename = type === 'compra' ? 'oferta-comercial-compra.md' : 'solicitud-estudio-arrendamiento.md';

    return {
      text: 'Aquí tienes el borrador diligenciado. Puedes copiarlo o descargarlo; si quieres ajustarlo, envíame los datos corregidos.\n\n' + doc,
      file: { name: filename, content: doc }
    };
  }

  function demoResponse(text) {
    var flow = state.flow;
    if (!state.demo || state.demo.flow !== flow) {
      state.demo = { flow: flow, step: 0, data: {} };
    }
    if (flow === 'calculadora') return demoCalculadora(text, state.demo);
    if (flow === 'auditoria') return demoAuditoria(text, state.demo);
    if (flow === 'match') return demoMatch(text, state.demo);
    return {
      text: 'Estoy en **Modo Demo**. Elige una de las tres acciones rápidas para comenzar:\n\n' +
        '- **Calcular cierre**\n- **Revisar tradición**\n- **Oferta / arriendo**'
    };
  }

  /* =========================================================
     Archivos (.txt y .pdf con pdf.js vía CDN)
     ========================================================= */

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!state.pdfPromise) {
      state.pdfPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = C.pdfJsUrl;
        script.onload = function () {
          try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = C.pdfWorkerUrl; }
          catch (e) { /* versiones sin worker explícito */ }
          resolve(window.pdfjsLib);
        };
        script.onerror = function () {
          state.pdfPromise = null;
          reject(new Error('No se pudo cargar pdf.js desde el CDN. Usa un .txt o pega el texto.'));
        };
        document.head.appendChild(script);
      });
    }
    return state.pdfPromise;
  }

  function pageText(pdf, number) {
    return pdf.getPage(number).then(function (page) {
      return page.getTextContent().then(function (content) {
        return content.items.map(function (item) { return item.str || ''; }).join(' ');
      });
    });
  }

  function extractPdfText(file) {
    return loadPdfJs().then(function (lib) {
      return file.arrayBuffer
        ? file.arrayBuffer().then(function (buffer) { return lib.getDocument({ data: new Uint8Array(buffer) }).promise; })
        : readAsArrayBuffer(file).then(function (buffer) { return lib.getDocument({ data: new Uint8Array(buffer) }).promise; });
    }).then(function (pdf) {
      var tasks = [];
      for (var page = 1; page <= pdf.numPages; page++) tasks.push(pageText(pdf, page));
      return Promise.all(tasks).then(function (parts) { return parts.join('\n\n'); });
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('No se pudo leer el archivo.')); };
      reader.readAsText(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('No se pudo leer el archivo.')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function readFile(file) {
    if (!file) return Promise.reject(new Error('Selecciona un archivo.'));
    if (file.size > C.maxFileSizeMB * 1024 * 1024) {
      return Promise.reject(new Error('El archivo supera ' + C.maxFileSizeMB + ' MB.'));
    }
    var extension = (file.name.split('.').pop() || '').toLowerCase();
    if (extension === 'txt' || file.type === 'text/plain') return readAsText(file);
    if (extension === 'pdf' || file.type === 'application/pdf') return extractPdfText(file);
    return Promise.reject(new Error('Formato no soportado. Usa .txt o .pdf.'));
  }

  function handleFile(file) {
    return readFile(file).then(function (text) {
      if (!text || !text.trim()) {
        throw new Error('No se extrajo texto. Si el PDF es escaneado, pega el contenido manualmente.');
      }
      var message = state.flow === 'auditoria'
        ? 'Revisa este certificado:\n\n' + text
        : 'Archivo adjunto: ' + file.name + '\n\n' + text;
      return submitText(message);
    }).catch(function (error) {
      addMessage('assistant', 'No pude leer el archivo: **' + error.message + '**');
      toast(error.message);
    }).then(function () {
      dom.fileInput.value = '';
    });
  }

  /* =========================================================
     Acciones de la interfaz
     ========================================================= */

  function updateStatus() {
    var live = isOnline();
    dom.status.textContent = live ? 'Modo Online' : 'Modo Demo';
    dom.status.classList.toggle('is-live', live);
    dom.subtitle.textContent = live ? 'Modo Online · ' + C.model : 'Modo Demo · sin API Key';
  }

  function activateTab(name) {
    if (['agente', 'tramites', 'contacto'].indexOf(name) === -1) return;
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (button) {
      var active = button.getAttribute('data-tab') === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (panel) {
      var active = panel.id === 'panel-' + name;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
  }

  function showTab(name) {
    activateTab(name);
    var bar = document.querySelector('.segment-bar');
    if (bar && bar.scrollIntoView) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function guardarContacto(record) {
    try {
      var existing = JSON.parse(localStorage.getItem(CONTACTO.storageKey) || '[]');
      if (!Array.isArray(existing)) existing = [];
      existing.push(record);
      localStorage.setItem(CONTACTO.storageKey, JSON.stringify(existing));
    } catch (e) { /* localStorage bloqueado: el formulario sigue siendo visible */ }
  }

  function submitContacto() {
    var nombre = $('contacto-nombre');
    var telefono = $('contacto-telefono');
    var email = $('contacto-email');
    var mensaje = $('contacto-mensaje');
    if (!nombre || !telefono || !email || !mensaje) return;

    var fields = [nombre, telefono, email, mensaje];
    fields.forEach(function (field) { field.classList.remove('is-invalid'); });

    var data = {
      nombre: nombre.value.trim(),
      telefono: telefono.value.trim(),
      email: email.value.trim(),
      mensaje: mensaje.value.trim(),
      fecha: new Date().toISOString()
    };
    var errores = [];
    if (!data.nombre) errores.push(nombre);
    if (!data.telefono) errores.push(telefono);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errores.push(email);
    if (!data.mensaje) errores.push(mensaje);

    var errorBox = $('contacto-error');
    if (errorBox) errorBox.hidden = errores.length === 0;
    if (errores.length) {
      errores.forEach(function (field) { field.classList.add('is-invalid'); });
      errores[0].focus();
      return;
    }

    guardarContacto(data);
    var asunto = 'Solicitud de asesoría inmobiliaria - ' + data.nombre;
    var cuerpo = 'Nombre completo: ' + data.nombre + '\n' +
      'Teléfono / WhatsApp: ' + data.telefono + '\n' +
      'Correo electrónico: ' + data.email + '\n\n' +
      'Breve resumen de la inquietud:\n' + data.mensaje;

    var mail = $('contacto-mail');
    var wa = $('contacto-whatsapp');
    if (mail) mail.href = 'mailto:' + CONTACTO.email + '?subject=' + encodeURIComponent(asunto) + '&body=' + encodeURIComponent(cuerpo);
    if (wa) wa.href = 'https://wa.me/' + CONTACTO.phone + '?text=' + encodeURIComponent(cuerpo);
    var confirmacion = $('contacto-confirmacion');
    if (confirmacion) confirmacion.hidden = false;
    toast('Solicitud registrada. Puedes enviarla por correo o WhatsApp.');
  }

  function openPanel() {
    activateTab('agente');
    dom.panel.hidden = false;
    var placeholder = $('chat-placeholder');
    if (placeholder) placeholder.hidden = true;
    dom.launcher.setAttribute('aria-expanded', 'true');
    setTimeout(function () { dom.input.focus(); scrollToBottom(); }, 30);
  }

  function closePanel() {
    dom.panel.hidden = true;
    var placeholder = $('chat-placeholder');
    if (placeholder) placeholder.hidden = false;
    dom.launcher.setAttribute('aria-expanded', 'false');
  }

  function focusChat() {
    openPanel();
    if (dom.panel.scrollIntoView) {
      dom.panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearConversation() {
    state.messages = [];
    state.demo = { flow: state.flow, step: 0, data: {} };
    state.lastFile = null;
    renderMessages();
    addMessage('assistant', 'Conversación limpiada. Elige una skill o escribe una nueva consulta para continuar.');
    toast('Conversación limpiada.');
  }

  function copyLastAnswer() {
    var last = null;
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant') { last = state.messages[i]; break; }
    }
    if (last) copyText(last.text);
    else toast('Aún no hay una respuesta para copiar.');
  }

  // Abre el chat con el contexto de un acto de la "Guía de actos y requisitos".
  function consultActo(nombre) {
    var acto = String(nombre || '').trim();
    if (!acto) return;

    showTab('agente');
    state.flow = '';
    state.demo = { flow: '', step: 0, data: {} };
    state.lastFile = null;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
      chip.classList.remove('is-active');
    });

    openPanel();
    addMessage('assistant', '**Acto seleccionado:** ' + acto + '\n\nConsultando los requisitos aplicables…');
    submitText('Consulta sobre ' + acto + ': ¿qué requisitos aplican en Colombia?');
  }

  function startFlow(flow) {
    if (!P.FLOW_LABELS[flow]) return;
    state.flow = flow;
    state.demo = { flow: flow, step: 0, data: {} };
    state.messages = [];
    state.lastFile = null;
    renderMessages();

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
      chip.classList.toggle('is-active', chip.getAttribute('data-flow') === flow);
    });

    openPanel();
    addMessage('assistant', P.FLOW_INTROS[flow] || '¿En qué puedo ayudarte?');
  }

  var SKILL_PATTERNS = [
    { flow: 'calculadora', label: 'Calcular cierre', pattern: /calcular cierre|calcular gastos notariales/i },
    { flow: 'auditoria', label: 'Revisar tradición', pattern: /revisar tradici[oó]n/i },
    { flow: 'match', label: 'Perfilar y redactar', pattern: /perfilar y redactar/i }
  ];

  function detectSuggestions(text) {
    return SKILL_PATTERNS.filter(function (item) {
      return item.pattern.test(text) && item.flow !== state.flow;
    }).map(function (item) {
      return { flow: item.flow, label: item.label };
    });
  }

  function submitText(text) {
    var clean = String(text || '').trim();
    if (!clean || state.busy) return Promise.resolve();

    state.lastUserText = clean;
    addMessage('user', clean);
    dom.input.value = '';
    resizeInput();
    setBusy(true);

    var task = isOnline()
      ? callGemini()
      : Promise.resolve().then(function () { return demoResponse(clean); });

    return task.then(function (result) {
      var output = (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'text'))
        ? result
        : { text: String(result || '') };
      addMessage('assistant', output.text || 'No obtuve una respuesta.', {
        downloadable: !!(output.file && output.file.content),
        filename: output.file ? output.file.name : 'documento.md',
        suggestions: isOnline() ? detectSuggestions(output.text || '') : []
      });
      if (output.file) state.lastFile = output.file;
    }).catch(function (error) {
      var message = error && error.message ? error.message : 'Error desconocido';
      var code = error && error.code;
      var action = null;
      var detail;
      if (code === 'AUTH') {
        detail = 'Tu orientación seguirá disponible en **Modo Demo** mientras actualizas la clave.';
        action = { type: 'demo', label: 'Ir a Modo Demo' };
      } else if (code === 'QUOTA') {
        detail = 'Puedes esperar y reintentar, o continuar en **Modo Demo**.';
        action = { type: 'demo', label: 'Ir a Modo Demo' };
      } else if (isOnline()) {
        detail = 'Revisa tu conexión o actualiza la clave en **Configurar API Key**.';
        action = { type: 'retry', label: 'Reintentar' };
      } else {
        detail = 'Intenta de nuevo o reformula la consulta.';
      }
      addMessage('assistant', '**' + message + '**\n\n' + detail, { action: action });
      toast(message);
    }).then(function () {
      setBusy(false);
    });
  }

  function resizeInput() {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(dom.input.scrollHeight, 110) + 'px';
  }

  function downloadText(text, name, type) {
    var blob = new Blob([text], { type: type || 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name || 'documento.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
  }

  function copyText(text) {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { toast('Copiado al portapapeles.'); })
        .catch(function () { toast(fallback() ? 'Copiado al portapapeles.' : 'No se pudo copiar.'); });
    }
    toast(fallback() ? 'Copiado al portapapeles.' : 'No se pudo copiar.');
    return Promise.resolve();
  }

  function openKeyModal() {
    dom.keyInput.value = state.key;
    dom.modal.hidden = false;
    setTimeout(function () { dom.keyInput.focus(); }, 30);
  }

  function closeKeyModal() {
    dom.modal.hidden = true;
  }

  function saveKey(value) {
    var key = String(value == null ? '' : value).trim();
    if (key && !isValidApiKey(key)) {
      toast('La API Key de Gemini debe empezar por "AIza" o "AQ.". No se guardó.');
      if (dom.keyInput && typeof dom.keyInput.setCustomValidity === 'function') {
        dom.keyInput.setCustomValidity('La API Key debe empezar por AIza o AQ.');
        if (typeof dom.keyInput.reportValidity === 'function') dom.keyInput.reportValidity();
      }
      return false;
    }
    if (dom.keyInput && typeof dom.keyInput.setCustomValidity === 'function') dom.keyInput.setCustomValidity('');

    if (key) {
      if (!safeWriteKey(key)) {
        toast('El navegador bloqueó localStorage. El Modo Demo sigue disponible.');
        return false;
      }
      state.key = key;
      toast('API Key guardada. Modo Online activado.');
    } else {
      safeRemoveKey();
      state.key = '';
      toast('Clave eliminada. Modo Demo activado.');
    }
    updateStatus();
    closeKeyModal();
    return true;
  }

  /* =========================================================
     Inicialización
     ========================================================= */

  function init() {
    dom = {
      status: $('api-status'),
      settings: $('settings-btn'),
      launcher: $('chat-launcher'),
      panel: $('chat-panel'),
      close: $('chat-close'),
      chatSettings: $('chat-settings'),
      download: $('chat-download'),
      subtitle: $('chat-subtitle'),
      messages: $('chat-messages'),
      typing: $('typing'),
      form: $('chat-form'),
      input: $('chat-input'),
      attach: $('attach-btn'),
      fileInput: $('file-input'),
      attachmentNote: $('attachment-note'),
      send: $('send-btn'),
      modal: $('key-modal'),
      keyForm: $('key-form'),
      keyInput: $('api-key-input'),
      keyClear: $('key-clear'),
      toast: $('toast')
    };

    if (!dom.panel || !dom.messages || !dom.form) return;

    state.key = safeReadKey();
    if (state.key && !isValidApiKey(state.key)) {
      safeRemoveKey();
      state.key = '';
    }
    updateStatus();

    activateTab('agente');

    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (button) {
      button.addEventListener('click', function () { showTab(button.getAttribute('data-tab')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab-go]'), function (button) {
      button.addEventListener('click', function () { showTab(button.getAttribute('data-tab-go')); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-flow]'), function (button) {
      button.addEventListener('click', function () { startFlow(button.getAttribute('data-flow')); });
    });

    var contactForm = $('contacto-form');
    if (contactForm) {
      contactForm.addEventListener('submit', function (event) {
        event.preventDefault();
        submitContacto();
      });
      ['contacto-nombre', 'contacto-telefono', 'contacto-email', 'contacto-mensaje'].forEach(function (id) {
        var field = $(id);
        if (field) field.addEventListener('input', function () { field.classList.remove('is-invalid'); });
      });
    }
    var copyEmail = $('copy-email-btn');
    if (copyEmail) copyEmail.addEventListener('click', function () { copyText(CONTACTO.email); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-acto]'), function (button) {
      button.addEventListener('click', function () { consultActo(button.getAttribute('data-acto')); });
    });

    var actosSearch = $('actos-search');
    if (actosSearch) {
      actosSearch.addEventListener('input', function () {
        var query = actosSearch.value.trim().toLowerCase();
        var visible = 0;
        Array.prototype.forEach.call(document.querySelectorAll('.act-card'), function (card) {
          var match = !query || card.textContent.toLowerCase().indexOf(query) !== -1;
          card.hidden = !match;
          if (match) visible++;
        });
        var empty = $('actos-empty');
        if (empty) empty.hidden = visible !== 0;
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-ask]'), function (button) {
      button.addEventListener('click', function () {
        openPanel();
        submitText(button.getAttribute('data-ask'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-chat]'), function (button) {
      button.addEventListener('click', focusChat);
    });

    $('hero-open-btn').addEventListener('click', focusChat);
    $('open-assistant-btn').addEventListener('click', focusChat);
    dom.launcher.addEventListener('click', focusChat);
    dom.close.addEventListener('click', closePanel);

    var copyAnswer = $('chat-copy');
    if (copyAnswer) copyAnswer.addEventListener('click', copyLastAnswer);
    var clearChat = $('chat-clear');
    if (clearChat) clearChat.addEventListener('click', clearConversation);

    dom.settings.addEventListener('click', openKeyModal);
    dom.chatSettings.addEventListener('click', openKeyModal);
    dom.keyForm.addEventListener('submit', function (event) {
      event.preventDefault();
      saveKey(dom.keyInput.value.trim());
    });
    if (typeof dom.keyInput.setCustomValidity === 'function') {
      dom.keyInput.addEventListener('input', function () { dom.keyInput.setCustomValidity(''); });
    }
    dom.keyClear.addEventListener('click', function () { saveKey(''); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-close-modal]'), function (button) {
      button.addEventListener('click', closeKeyModal);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (!dom.modal.hidden) closeKeyModal();
        else if (!dom.panel.hidden) closePanel();
      }
    });

    dom.form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitText(dom.input.value);
    });

    dom.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitText(dom.input.value);
      }
    });
    dom.input.addEventListener('input', resizeInput);

    dom.attach.addEventListener('click', function () { dom.fileInput.click(); });
    dom.fileInput.addEventListener('change', function () {
      var file = dom.fileInput.files && dom.fileInput.files[0];
      if (file) handleFile(file);
    });

    dom.messages.addEventListener('click', function (event) {
      var suggestion = event.target.closest('.suggestion-chip');
      if (suggestion) {
        startFlow(suggestion.getAttribute('data-flow'));
        return;
      }

      var button = event.target.closest('.msg-action');
      if (!button) return;
      var index = Number(button.getAttribute('data-index'));
      var message = state.messages[index];
      if (!message) return;
      var action = button.getAttribute('data-action');

      if (action === 'copy') copyText(message.text);
      if (action === 'download') {
        downloadText(message.text, message.filename || 'documento.md');
      }
      if (action === 'demo') {
        saveKey('');
        addMessage('assistant', 'Modo Demo activado. Puedo seguir ayudándote sin conexión con los tres flujos disponibles.');
      }
      if (action === 'retry' && state.lastUserText) {
        submitText(state.lastUserText);
      }
    });

    dom.download.addEventListener('click', function () {
      var transcript = '# Conversación — Asesor Jurídico y Comercial IA\n\n' +
        state.messages.map(function (message) {
          return '### ' + (message.role === 'user' ? 'Visitante' : 'Asesor') + '\n\n' + message.text;
        }).join('\n\n');
      downloadText(transcript, 'conversacion-asesor-inmobiliario.md');
      toast('Conversación descargada.');
    });
  }

  window.AgentApp = {
    startFlow: startFlow,
    openPanel: openPanel,
    closePanel: closePanel,
    activateTab: showTab,
    consultActo: consultActo,
    submit: submitText
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
