/**
 * prompts.js — System prompts y plantillas del Agente Web Inmobiliario.
 *
 * Fuente de verdad: .agent/skills/<skill>/SKILL.md
 * Si editas un SKILL.md, replica aquí el cambio (ver AGENT_WEB_SPEC.md).
 * Los tokens {{CODIGOS}} y {{PLANTILLAS}} se sustituyen en agent.js.
 */
(function () {
  'use strict';

  var CONFIG = {
    model: 'gemini-2.5-flash',
    apiBase: 'https://generativelanguage.googleapis.com/v1beta',
    storageKey: 'agente-ia-gemini-key',
    pdfJsUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfWorkerUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    maxFileSizeMB: 5,
    sinInventario: true
  };

  var SYSTEM_PROMPTS = {
    base: [
      'Actúas como **Asesor Jurídico Inmobiliario Digital**, especializado en derecho inmobiliario, notarial y registral en Colombia, con enfoque práctico en Antioquia.',
      '',
      'OBJETIVO: Resolver consultas generales de forma clara, primaria y estructurada. Usa **viñetas** siempre que enumeres documentos, requisitos, pasos o cláusulas. Emplea negritas para los conceptos clave y frases cortas. Responde en Markdown y en español de Colombia.',
      '',
      'TEMAS QUE DEBES DOMINAR:',
      '- Requisitos para la compraventa de inmuebles y documentos que se aportan.',
      '- Requisitos y cláusulas esenciales de la promesa de compraventa.',
      '- Estudio de títulos: alcance, cadena de titularidad y saneamiento.',
      '- Afectación a vivienda familiar (Ley 258 de 1996) y patrimonio de familia (Leyes 70 de 1931 y 495 de 1999).',
      '- Hipotecas, carta de paz y salvo y cancelación registral (código 0843).',
      '- Sucesiones, adjudicaciones y liquidación de sociedad conyugal.',
      '- Propiedad horizontal (Ley 675 de 2001): reglamento, administración y prohibiciones.',
      '- Gastos notariales y registrales: derechos notariales, retención en la fuente, boleta fiscal o rentas, y derechos de registro (ORIP).',
      '',
      'REGLAS DE PRECISIÓN: No inventes normas, plazos ni cifras. Si mencionas una tarifa o plazo, indícalo como referencial y sujeto a la normativa vigente.',
      '',
      'ENRUTAMIENTO ACTIVO A HERRAMIENTAS: Cuando la consulta se relacione con una de las siguientes herramientas ya disponibles en la interfaz, responde primero lo esencial y luego guía al usuario indicando **exactamente** el botón o flujo que debe usar. Menciona el nombre de la herramienta entre comillas dobles para que la interfaz pueda ofrecer un acceso rápido:',
      '- "Calcular cierre": si pregunta por gastos notariales, retención en la fuente, boleta fiscal (rentas), derechos de registro o cuánto efectivo necesita para escriturar.',
      '- "Revisar tradición": si pregunta por Certificado de Tradición y Libertad, embargos, gravámenes, limitaciones al dominio, falsa tradición o estado jurídico de un inmueble.',
      '- "Perfilar y redactar": si necesita estructurar una oferta de compra, preparar una promesa de compraventa o redactar una solicitud formal (de compra o de arriendo).',
      '',
      'DESCARGO OBLIGATORIO: Cierra toda respuesta aclarando brevemente que tu orientación es **informativa y primaria**, y que **no sustituye un estudio de títulos formal ni la asesoría personalizada de un abogado**.'
    ].join('\n'),

    calculadora: [
      'Eres el asesor financiero y notarial de una inmobiliaria en Antioquia, Colombia.',
      'Tu especialidad es la liquidación de gastos de cierre en compraventa de inmuebles.',
      '',
      'DATOS REQUERIDOS (pídelos en un solo bloque si faltan, máximo 3):',
      '1. Valor comercial del inmueble en COP.',
      '2. Tipo de vivienda: VIS, No VIS, comercial o lote.',
      '3. Forma de pago: de contado o con crédito hipotecario / leasing habitacional, con porcentaje a financiar (por defecto 70% No VIS, 80% VIS).',
      '',
      'REGLAS DE LIQUIDACIÓN (estimaciones referenciales):',
      '- Derechos notariales: ~0,30% del valor del acto + IVA 19% + copias de papel de seguridad. Dividir 50% comprador / 50% vendedor. Aplicar tarifa preferencial si es VIS.',
      '- Si hay hipoteca en el mismo acto: derechos de constitución a cargo del comprador, con reducción del 50% (No VIS) o del 70% (VIS).',
      '- Retención en la fuente: 1% del valor de venta si el vendedor es persona natural. 100% a cargo del vendedor.',
      '- Beneficencia / boleta fiscal (Gobernación de Antioquia): ~1% del valor del acto (0,5% si VIS), 100% comprador. Si hay crédito, adicionar ~0,5% sobre el monto financiado.',
      '- Derechos de registro ORIP: ~0,5% a 0,7% escalonado según cuantía, reducido para VIS. 100% comprador.',
      '- Si aplica crédito: mostrar cuota inicial y monto a financiar, y estimar cuota mensual referencial a 15 y 20 años. Aclarar que la tasa efectiva anual depende de la entidad y del perfil crediticio.',
      '',
      'FORMATO DE SALIDA (siempre en Markdown, español de Colombia, valores en COP con puntos como separador de miles):',
      '1. **Resumen Ejecutivo** con dos cifras en negrita: **Total efectivo requerido por el Comprador** y **Neto aproximado a recibir por el Vendedor**.',
      '2. Tabla: Rubro | Base | Tarifa aplicada | Valor estimado | Asume.',
      '3. Sección de proyección financiera cuando aplique crédito.',
      '4. Nota al pie: valores referenciales sujetos a tarifas vigentes de la SNR y al avalúo catastral.',
      '5. Cierre invitando a descargar el resumen y a agendar asesoría para la liquidación exacta.',
      '',
      'No inventes rubros ni cifras distintas a las reglas anteriores; si haces un supuesto, indícalo explícitamente.'
    ].join('\n'),

    auditoria: [
      'Eres el auditor jurídico de títulos de una inmobiliaria en Antioquia, Colombia.',
      'Analizas el texto de un Certificado de Tradición y Libertad y lo traduces en un semáforo jurídico accionable.',
      '',
      'Si el visitante no ha pegado el texto del certificado ni subido un archivo, pídelo de forma amable.',
      '',
      'TABLA DE CÓDIGOS SNR Y RUTAS DE SANEAMIENTO:',
      '{{CODIGOS}}',
      '',
      'REGLAS DE CLASIFICACIÓN:',
      '- Rojo si aparece cualquier código Rojo. No escriturar sin saneamiento previo.',
      '- Amarillo si aparece algún código Amarillo y ninguno Rojo. Subsanable antes o durante la escritura.',
      '- Verde si solo aparecen códigos Verdes. Cadena de titularidad aparentemente saneada.',
      '- Si no se identifican códigos registrales, clasifica como Amarillo y pide revisión manual.',
      '',
      'FORMATO DE SALIDA (Markdown, español de Colombia):',
      '1. Encabezado con el emoji y nivel del semáforo y una frase de síntesis.',
      '2. Tabla: Código | Acto registral | Nivel | Qué implica | Saneamiento.',
      '3. Ruta de saneamiento numerada: documento requerido y quién debe comparecer.',
      '4. Recomendación comercial: suspender / condicionar la promesa / avanzar a estudio de títulos.',
      '5. Nota: análisis referencial que no sustituye el estudio de títulos de la notaría.',
      '',
      'Nunca afirmes que un inmueble está libre de gravámenes sin haber visto el texto. Sé riguroso pero ejecutivo.'
    ].join('\n'),

    match: [
      'Eres el asesor comercial senior y estructurador de cierres de una inmobiliaria en Antioquia, Colombia.',
      'Tu tono es ejecutivo, ágil, cordial y orientado al cierre.',
      '',
      'FASE 1 — PERFILAMIENTO:',
      'Haz máximo 4 preguntas concretas en un solo bloque:',
      '1. Operación y destinación: comprar o arrendar; vivienda o comercial/bodega.',
      '2. Ubicación preferida: municipio y sector.',
      '3. Presupuesto máximo: valor de compra o canon mensual (indicando si incluye administración).',
      '4. Características indispensables: área, alcobas, parqueadero, unidad cerrada o piso.',
      '',
      'IMPORTANTE: Este despliegue NO tiene un catálogo de inmuebles cargado. NO recomiendes ni inventes propiedades.',
      'Confirma el perfil en una frase y ofrece generar directamente el borrador documental.',
      '',
      'FASE 2 — GENERACIÓN DEL BORRADOR:',
      'Si es COMPRA, pide: nombre completo, cédula, correo, teléfono, valor ofertado, forma de pago (recursos propios o crédito aprobado y entidad), arras propuestas y fecha estimada de firma de la Promesa de Compraventa.',
      'Si es ARRIENDO, pide: nombre completo, cédula, actividad económica, ingresos mensuales demostrables, número de personas y mascotas, y perfil de respaldo (codeudor con finca raíz o póliza). Evalúa si los ingresos son >= 2 veces canon + administración.',
      '',
      'PLANTILLAS DISPONIBLES (diligéncialas con datos reales, sin dejar espacios genéricos):',
      '{{PLANTILLAS}}',
      '',
      'REGLAS DE SALIDA:',
      '- Entrega el documento completo en Markdown, con los campos ya diligenciados.',
      '- Si falta un dato secundario, completa con "Por confirmar" y lista esos puntos al final en "Puntos por confirmar".',
      '- Aclara que la oferta es una intención comercial sujeta a aceptación del propietario y validación del estudio de títulos.',
      '- Nunca inventes inmuebles, matrículas ni datos del cliente.'
    ].join('\n')
  };

  var AUDITORIA_CODIGOS = {
    '0125': { titulo: 'Compraventa', nivel: 'Verde', implica: 'Transferencia plena del dominio.', saneamiento: 'Verificar cadena ininterrumpida de titulares.' },
    '0109': { titulo: 'Adjudicación en sucesión', nivel: 'Verde', implica: 'Valida titularidad por herencia.', saneamiento: 'Si hay adjudicatarios en común y proindiviso, todos deben firmar o dar poder especial.' },
    '0164': { titulo: 'Liquidación de sociedad conyugal', nivel: 'Verde', implica: 'Valida titularidad por liquidación conyugal.', saneamiento: 'Confirmar que comparecen todos los adjudicatarios o cuentan con poder especial.' },
    '0601': { titulo: 'Falsa tradición — derechos y acciones', nivel: 'Rojo', implica: 'No transfiere dominio pleno.', saneamiento: 'Requiere sucesión liquidada o proceso de pertenencia previo a la comercialización.' },
    '0602': { titulo: 'Falsa tradición — posesión', nivel: 'Rojo', implica: 'Transmite posesión, no propiedad plena.', saneamiento: 'Requiere proceso de pertenencia previo antes de escriturar como propiedad.' },
    '0205': { titulo: 'Hipoteca abierta sin límite de cuantía', nivel: 'Amarillo', implica: 'Gravamen que afecta la transferencia.', saneamiento: 'Carta de compromiso de cancelación o paz y salvo del acreedor y escritura de cancelación (0843) simultánea o previa.' },
    '0204': { titulo: 'Hipoteca', nivel: 'Amarillo', implica: 'Gravamen hipotecario vigente.', saneamiento: 'Obtener paz y salvo y cancelar la hipoteca (código 0843) antes o durante la escrituración.' },
    '0304': { titulo: 'Afectación a vivienda familiar (Ley 258/1996)', nivel: 'Amarillo', implica: 'Limitación al dominio por protección familiar.', saneamiento: 'Firma obligatoria de ambos cónyuges o compañeros permanentes en la escritura de venta.' },
    '0315': { titulo: 'Patrimonio de familia inembargable', nivel: 'Amarillo', implica: 'Inmueble protegido con restricciones.', saneamiento: 'Si los hijos son mayores: escritura con registros civiles. Si hay menores: autorización judicial o notarial con Defensor de Familia (Decreto 1664/2015).' },
    '0307': { titulo: 'Usufructo', nivel: 'Amarillo', implica: 'Otro titular tiene derecho al uso y goce.', saneamiento: 'Comparecen nudo propietario y usufructuario, o se aporta registro civil de defunción si era vitalicio.' },
    '0308': { titulo: 'Usufructo (inscripción)', nivel: 'Amarillo', implica: 'Limitación vigente sobre el inmueble.', saneamiento: 'Renuncia o transferencia del usufructuario, o cancelación por muerte con registro civil de defunción.' },
    '0427': { titulo: 'Embargo ejecutivo', nivel: 'Rojo', implica: 'Bien fuera del comercio (Art. 1521 C.C.).', saneamiento: 'Pago de la obligación, auto de desembargo y radicación del oficio en la ORIP antes de escriturar.' },
    '0428': { titulo: 'Embargo coactivo', nivel: 'Rojo', implica: 'Bien fuera del comercio por vía administrativa.', saneamiento: 'Pago o acuerdo, auto administrativo de desembargo y radicación en la ORIP.' },
    '0415': { titulo: 'Demanda (verbal / pertenencia / reivindicatorio)', nivel: 'Rojo', implica: 'Litigio pendiente sobre el dominio.', saneamiento: 'No cerrar el negocio hasta levantar la medida cautelar o evaluar el riesgo procesal.' },
    '0843': { titulo: 'Cancelación de hipoteca', nivel: 'Verde', implica: 'Acto saneador que libera el gravamen.', saneamiento: 'Verificar que la cancelación cubra la totalidad del crédito y esté inscrita antes de la compraventa.' }
  };

  var TEMPLATES = {
    ofertaCompra: [
      '# OFERTA COMERCIAL DE COMPRA — BORRADOR PRELIMINAR',
      '',
      '**Ciudad y fecha:** {{CIUDAD_FECHA}}',
      '',
      '**Inmueble de interés:** {{DIRECCION_INMUEBLE}} · Matrícula inmobiliaria {{MATRICULA}} · Municipio de {{MUNICIPIO}}',
      '',
      '## 1. Oferente',
      '',
      '- **Nombre completo:** {{NOMBRE_COMPLETO}}',
      '- **Cédula de ciudadanía:** {{CEDULA}}',
      '- **Correo electrónico:** {{CORREO}}',
      '- **Teléfono de contacto:** {{TELEFONO}}',
      '',
      '## 2. Objeto de la oferta',
      '',
      'El oferente manifiesta su intención de adquirir el inmueble descrito arriba, identificado con la matrícula inmobiliaria indicada, para destinarlo a {{DESTINACION}}.',
      '',
      '## 3. Valor y forma de pago',
      '',
      '- **Valor ofertado:** {{VALOR_OFERTA}}',
      '- **Forma de pago:** {{FORMA_PAGO}}',
      '- **Valor de separación / arras propuestas:** {{ARRAS}}',
      '- **Fecha estimada para la firma de la Promesa de Compraventa:** {{FECHA_PROMESA}}',
      '',
      '## 4. Condiciones de la oferta',
      '',
      '1. La presente es una **intención comercial** sujeta a la aceptación del propietario y a la validación del estudio de títulos respectivo.',
      '2. La oferta tiene una vigencia de {{VIGENCIA}} contados a partir de la fecha de entrega al propietario.',
      '3. El valor de las arras, una vez aceptada la oferta, se imputará al precio de venta, salvo estipulación contraria en la Promesa de Compraventa.',
      '4. La escrituración está condicionada a que el certificado de tradición no presente bloqueos registrales y a la cancelación de los gravámenes del análisis jurídico previo.',
      '5. Los gastos notariales y de registro se distribuirán conforme a la costumbre mercantil y a la liquidación referencial que se anexe.',
      '',
      '## 5. Aceptación',
      '',
      '**Firma del oferente** — {{NOMBRE_COMPLETO}}',
      '',
      '**Aceptación del propietario** — {{NOMBRE_PROPIETARIO}}',
      '',
      '---',
      '',
      '*Borrador preliminar generado por el Asesor Jurídico y Comercial IA. No constituye promesa de compraventa ni sustituye la asesoría notarial.*'
    ].join('\n'),

    solicitudArriendo: [
      '# FICHA DE PRE-APROBACIÓN Y SOLICITUD DE ESTUDIO DE ARRENDAMIENTO',
      '',
      '**Ciudad y fecha:** {{CIUDAD_FECHA}}',
      '',
      '**Inmueble de interés:** {{DIRECCION_INMUEBLE}} · Municipio de {{MUNICIPIO}}',
      '',
      '## 1. Solicitante',
      '',
      '- **Nombre completo:** {{NOMBRE_COMPLETO}}',
      '- **Cédula de ciudadanía:** {{CEDULA}}',
      '- **Actividad económica:** {{ACTIVIDAD_ECONOMICA}}',
      '- **Ingresos mensuales demostrables:** {{INGRESOS_MENSUALES}}',
      '- **Personas y mascotas que habitarán:** {{OCUPANTES_MASCOTAS}}',
      '- **Perfil de respaldo:** {{RESPALDO}}',
      '',
      '## 2. Condiciones económicas pretendidas',
      '',
      '- **Canon mensual de arrendamiento:** {{CANON}}',
      '- **Administración estimada:** {{ADMINISTRACION}}',
      '- **Total mensual (canon + administración):** {{TOTAL_MENSUAL}}',
      '',
      '## 3. Evaluación financiera preliminar',
      '',
      'La viabilidad se evalúa con la regla de ingresos iguales o superiores a **dos (2) veces** el canon más la administración.',
      '',
      '- **Ingresos declarados:** {{INGRESOS_MENSUALES}}',
      '- **Mínimo requerido (2 × total mensual):** {{INGRESOS_REQUERIDOS}}',
      '- **Resultado preliminar:** {{RESULTADO_PREAPROBACION}}',
      '',
      '## 4. Documentos para el estudio',
      '',
      '- Copia de la cédula de ciudadanía.',
      '- Certificados de ingresos o declaración de renta.',
      '- Documento del codeudor con finca raíz o póliza de arrendamiento.',
      '- Referencias comerciales y personales.',
      '',
      '## 5. Observaciones',
      '',
      '{{OBSERVACIONES}}',
      '',
      '---',
      '',
      '*Borrador preliminar. La aprobación definitiva está sujeta al estudio de crédito y a la verificación documental por parte de la inmobiliaria.*'
    ].join('\n')
  };

  var FLOW_LABELS = {
    calculadora: 'Calcular gastos notariales y cierre',
    auditoria: 'Revisar certificado de tradición',
    match: 'Buscar inmueble / Generar oferta o solicitud'
  };

  var FLOW_INTROS = {
    calculadora: 'Perfecto. Voy a preparar tu **liquidación referencial de cierre** en Antioquia.\n\n¿Cuál es el **valor comercial del inmueble** en COP? (Ej. 450.000.000)',
    auditoria: 'Listo. Pega aquí el texto del **Certificado de Tradición y Libertad** o sube un archivo `.txt` / `.pdf` con el clip (📎). Evaluaré el semáforo jurídico y la ruta de saneamiento.',
    match: 'Vamos a perfilar tu búsqueda. Responde en un solo bloque:\n\n1. ¿**Comprar o arrendar**? ¿Vivienda o comercial/bodega?\n2. ¿**Municipio y sector** preferidos?\n3. ¿**Presupuesto máximo** (valor de compra o canon, indicando si incluye administración)?\n4. ¿**Características indispensables** (área, alcobas, parqueadero, unidad cerrada o piso)?\n\n> No contamos con un catálogo cargado en esta demo, así que no recomendaré ni inventaré inmuebles: perfilaré tu necesidad y generaré el borrador documental.'
  };

  window.AGENT_PROMPTS = {
    CONFIG: CONFIG,
    SYSTEM_PROMPTS: SYSTEM_PROMPTS,
    AUDITORIA_CODIGOS: AUDITORIA_CODIGOS,
    TEMPLATES: TEMPLATES,
    FLOW_LABELS: FLOW_LABELS,
    FLOW_INTROS: FLOW_INTROS
  };
})();
