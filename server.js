const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise'); 

let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do banco de dados
const db = mysql.createPool({
  host: 'localhost',    
  user: 'root',          // seu usuário
  password: '',          // sua senha
  database: 'ecoquiz',   // nome do banco
});

const WIKI_LANG = process.env.WIKI_LANG || 'pt';
const WIKI_REST_BASE = `https://${WIKI_LANG}.wikipedia.org/api/rest_v1`;
const summaryUrl = (title) => `${WIKI_REST_BASE}/page/summary/${encodeURIComponent(title)}`;
const relatedUrl = (title) => `${WIKI_REST_BASE}/page/related/${encodeURIComponent(title)}`;
const searchUrl = (query) =>
  `https://${WIKI_LANG}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=10&srsearch=${encodeURIComponent(query)}`;

const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
const pickN = (arr, n) => shuffle([...arr]).slice(0, n);

// Tópicos prontos
const SUSTAIN_TOPICS = [
  'Energia renovável',
  'Reciclagem',
  'Mudanças climáticas',
  'Desmatamento',
  'Poluição da água',
  'Gás de efeito estufa',
  'Energia solar',
  'Energia eólica',
  'Biodiversidade',
];

// Função corrigida e melhorada para gerar perguntas descritivas
async function buildDescriptionQuestion(mainTitle) {
  const [sumRes, relRes, searchRes] = await Promise.all([
    fetchFn(summaryUrl(mainTitle)),
    fetchFn(relatedUrl(mainTitle)),
    fetchFn(searchUrl(mainTitle)),
  ]);

  if (!sumRes.ok) throw new Error('Resumo não encontrado para o título principal.');
  const sum = await sumRes.json();

  // Resposta correta (primeira letra maiúscula)
  let correct = sum.description || sum.extract?.split('. ')[0] || 'Conceito da Wikipédia';
  correct = correct.charAt(0).toUpperCase() + correct.slice(1);

  // Distractors via descrições das páginas relacionadas
  let relatedDescriptions = [];
  if (relRes.ok) {
    const rel = await relRes.json();
    relatedDescriptions = (rel?.pages || []).map(p => p.description).filter(Boolean);
  }

  // Distractors via snippets de busca na Wikipédia
  let searchSnippets = [];
  if (searchRes.ok) {
    const searchData = await searchRes.json();
    searchSnippets = (searchData?.query?.search || [])
      .map(item => item.snippet.replace(/<\/?[^>]+(>|$)/g, ""))  // remove tags HTML
      .filter(text => text.length > 20 && text.toLowerCase() !== correct.toLowerCase());
  }

  // Junta tudo, remove duplicados e retira o texto correto
  const allDistractorsRaw = [...relatedDescriptions, ...searchSnippets];
  const uniqueDistractors = [...new Set(allDistractorsRaw)].filter(d => d.toLowerCase() !== correct.toLowerCase());

  // Pega até 3 distractors
  let distractors = pickN(uniqueDistractors, 3);

  // Se não tiver 3, preenche com fallback
  const fallback = [
    'Um fenômeno natural',
    'Uma organização',
    'Um evento histórico',
    'Um lugar',
    'Um conceito filosófico',
    'Um processo biológico',
  ];

  let fallbackIndex = 0;
  while (distractors.length < 3) {
    const candidate = fallback[fallbackIndex++ % fallback.length];
    if (!distractors.includes(candidate) && candidate.toLowerCase() !== correct.toLowerCase()) {
      distractors.push(candidate);
    }
  }

  // Embaralha as opções incluindo a correta
  const options = shuffle([correct, ...distractors]);

  return {
    type: 'multiple',
    question: `Qual é a melhor descrição de “${sum.title}”?`,
    options,
    answer: correct,
    source: sum?.content_urls?.desktop?.page || null,
  };
}

// Função para gerar pergunta relacionada
async function buildRelatedQuestion(mainTitle) {
  const relRes = await fetchFn(relatedUrl(mainTitle));
  if (!relRes.ok) throw new Error('Não foi possível obter páginas relacionadas.');
  const rel = await relRes.json();
  const relatedTitles = (rel?.pages || []).map((p) => p?.title).filter(Boolean);
  if (relatedTitles.length === 0) return buildDescriptionQuestion(mainTitle);

  const correct = relatedTitles[0];
  const genericDistractors = [
    'Futebol','Violino','Montanhismo','Revolução Francesa','Pintura impressionista',
    'Culinária italiana','Basquetebol','Cinema mudo','Arquitetura gótica','Geografia da Antártida'
  ];
  const distractors = pickN(genericDistractors.filter((d) => d !== mainTitle && d !== correct), 3);
  const options = shuffle([correct, ...distractors]);
  return {
    type: 'multiple',
    question: `Qual destes tópicos está mais diretamente associado a-“${mainTitle}”?`,
    options,
    answer: correct,
    source: `${WIKI_REST_BASE}/page/related/${encodeURIComponent(mainTitle)}`
  };
}

// Função para montar o quiz para um título
async function buildQuizForTitle(title, n = 5) {
  const questions = [];
  const builders = [buildDescriptionQuestion, buildRelatedQuestion];
  let i = 0;
  while (questions.length < n) {
    const builder = builders[i % builders.length];
    try {
      const q = await builder(title);
      const dup = questions.find((qq) => qq.question === q.question && JSON.stringify(qq.options) === JSON.stringify(q.options));
      if (!dup) questions.push(q);
    } catch (e) {
      try {
        const qAlt = await builders[(i + 1) % builders.length](title);
        questions.push(qAlt);
      } catch { break; }
    }
    i++;
  }
  return questions;
}

// Endpoint /search
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: 'Parâmetro q é obrigatório' });
  try {
    const r = await fetchFn(searchUrl(q));
    const data = await r.json();
    const results = (data?.query?.search || []).map((s) => ({
      title: s.title,
      snippet: s.snippet,
      pageid: s.pageid,
    }));
    res.json({ query: q, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erro ao buscar na Wikipédia' });
  }
});

// Endpoint /summary
app.get('/summary', async (req, res) => {
  const title = (req.query.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Parâmetro title é obrigatório' });
  try {
    const r = await fetchFn(summaryUrl(title));
    if (!r.ok) return res.status(r.status).json({ message: 'Página não encontrada na Wikipédia' });
    const sum = await r.json();
    res.json({
      title: sum.title,
      description: sum.description || '',
      extract: sum.extract || '',
      content_urls: sum.content_urls || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erro ao obter resumo da Wikipédia' });
  }
});

// Endpoint /quiz
app.get('/quiz', async (req, res) => {
  const title = (req.query.title || '').trim();
  const n = Math.min(parseInt(req.query.n || '5', 10) || 5, 10);
  if (!title) return res.status(400).json({ message: 'Parâmetro title é obrigatório' });
  try {
    const quiz = await buildQuizForTitle(title, n);
    if (!quiz.length) return res.status(404).json({ message: 'Não foi possível gerar perguntas.' });
    res.json({ title, count: quiz.length, questions: quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erro ao gerar quiz pela Wikipédia' });
  }
});

// Endpoint /quiz-sustentabilidade
app.get('/quiz-sustentabilidade', async (req, res) => {
  const n = Math.min(parseInt(req.query.n || '5', 10) || 5, 10);
  const topics = pickN(SUSTAIN_TOPICS, Math.min(n, SUSTAIN_TOPICS.length));
  try {
    const all = [];
    for (const t of topics) {
      const qs = await buildQuizForTitle(t, 1);
      all.push(...qs);
      if (all.length >= n) break;
    }
    const quiz = all.slice(0, n);
    if (!quiz.length) return res.status(404).json({ message: 'Não foi possível gerar perguntas.' });
    res.json({ title: 'Quiz de Sustentabilidade (Wikipédia)', count: quiz.length, questions: quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erro ao gerar quiz de sustentabilidade' });
  }
});

// Função para salvar pontuação no banco
async function saveScore(userName, score) {
  const [rows] = await db.query('SELECT idUsuario FROM usuarios WHERE nome = ?', [userName]);
  let userId;
  if (rows.length === 0) {
    const [res] = await db.query('INSERT INTO usuarios (nome, email, senha, telefone) VALUES (?, ?, ?, ?)', [
      userName,
      userName + '@exemplo.com',
      '123',
      '00000000000'
    ]);
    userId = res.insertId;
  } else {
    userId = rows[0].idUsuario;
  }
  await db.query('INSERT INTO pontuacao (pontuacao, usuario_id) VALUES (?, ?)', [score, userId]);
}

// Endpoint /score para receber e salvar pontuação
app.post('/score', async (req, res) => {
  const { user, score } = req.body || {};
  if (!user || typeof score !== 'number') return res.status(400).json({ message: 'Informe { user, score:number }' });
  try {
    await saveScore(user, score);
    res.json({ message: 'Pontuação registrada no banco!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erro ao salvar pontuação' });
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));