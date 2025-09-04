const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

// =================================================================
// CONFIGURAÇÕES
// =================================================================
const app = express();
app.use(cors());
const PORT = 3002;
const SPREADSHEET_ID = '11uYaOh6jJDsyNm1OPKnC_MpMcA9FL2aXWKPjeMlkhW4';

const auth = new google.auth.GoogleAuth({
    keyFile: 'credenciais.json',
    scopes: 'https://www.googleapis.com/auth/spreadsheets.readonly',
});

let cachedOrcamData = null;
let cachedAresData = null; // NOVO: Cache para os dados dos locais

function cleanCurrency(value) {
    if (typeof value !== 'string') return 0;
    const cleanedValue = value.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
    const number = parseFloat(cleanedValue);
    return isNaN(number) ? 0 : number;
}

// ALTERADO: Função principal de dados agora lê apenas BD_ORCAM
async function getOrcamData() {
    if (cachedOrcamData) return cachedOrcamData;
    try {
        console.log("Orçamento: Buscando dados da planilha de orçamento...");
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'BD_ORCAM!A:Z', // Lendo a aba de orçamento
        });
        
        const rows = response.data.values;
        if (!rows || rows.length < 2) return [];

        const header = rows[0].map(h => h ? h.trim() : 'UNKNOWN_COLUMN');
        const data = rows.slice(1).map(row => {
            let obj = {};
            header.forEach((key, i) => { obj[key] = row[i]; });
            return obj;
        });

        cachedOrcamData = data;
        setTimeout(() => { cachedOrcamData = null; }, 300000);
        return data;
    } catch (error) {
        console.error("Orçamento: Erro fatal ao buscar dados da planilha de orçamento:", error.message);
        return [];
    }
}

// NOVO: Função para buscar os dados da planilha de locais (BD_ARES)
async function getAresData() {
    if (cachedAresData) return cachedAresData;
    try {
        console.log("Locais: Buscando dados da planilha de locais...");
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'BD_ARES!A:C', // Lendo apenas as colunas A (TOMBAMENTO) e C (LOCAL)
        });
        
        const rows = response.data.values;
        if (!rows || rows.length < 2) return new Map();

        // Cria um mapa para busca rápida: { 'tombamento' => 'local' }
        const aresMap = new Map();
        rows.slice(1).forEach(row => {
            const tombamento = row[0]; // Coluna A
            const local = row[2];      // Coluna C
            if (tombamento && local) {
                aresMap.set(tombamento.trim(), local.trim());
            }
        });

        cachedAresData = aresMap;
        setTimeout(() => { cachedAresData = null; }, 300000); // Cache de 5 minutos
        return aresMap;
    } catch (error) {
        console.error("Locais: Erro fatal ao buscar dados da planilha de locais:", error.message);
        return new Map();
    }
}


// =================================================================
// ROTA ÚNICA E INTELIGENTE PARA O DASHBOARD DE ORÇAMENTO
// =================================================================
app.get('/api/orcamento-data', async (req, res) => {
    // ALTERADO: Busca os dois conjuntos de dados em paralelo
    const [allData, aresMap] = await Promise.all([
        getOrcamData(),
        getAresData()
    ]);

    let filteredData = [...allData];
    const ORCAMENTO_COL = 'N ORCAM';
    const { ano, mes, orcamento } = req.query;
    
    if (ano) filteredData = filteredData.filter(r => r['ANO'] == ano);
    if (mes) filteredData = filteredData.filter(r => r['MES'] == mes);
    if (orcamento) filteredData = filteredData.filter(r => r[ORCAMENTO_COL] === orcamento);

    // --- KPIs ---
    const valorTotalGasto = filteredData.reduce((sum, row) => sum + cleanCurrency(row['VALOR TOTAL']), 0);
    const quantidadeServicos = filteredData.length;
    const valorOrcado = valorTotalGasto;

    // --- Dados para Gráficos ---
    const gastoPorDepartamento = filteredData.reduce((acc, row) => {
        const group = row['DE'];
        if (group) acc[group] = (acc[group] || 0) + cleanCurrency(row['VALOR TOTAL']);
        return acc;
    }, {});

    // ALTERADO: A estrutura de dados agora será um array de objetos para facilitar a inclusão de mais campos
    const valorPorTombamentoMap = filteredData.reduce((acc, row) => {
        const group = row['TOMBAMENTO'];
        if (group) {
            if (!acc[group]) {
                acc[group] = {
                    tombamento: group,
                    valor: 0,
                    local: aresMap.get(group) || 'Não encontrado' // Busca o local no mapa
                };
            }
            acc[group].valor += cleanCurrency(row['VALOR TOTAL']);
        }
        return acc;
    }, {});
    const valorPorTombamento = Object.values(valorPorTombamentoMap);

    const servicosPorTombamentoMap = filteredData.reduce((acc, row) => {
        const group = row['TOMBAMENTO'];
        const item = row['ITEM'];
        if (group && item) {
            if (!acc[group]) {
                acc[group] = {
                    tombamento: group,
                    servicos: [],
                    local: aresMap.get(group) || 'Não encontrado' // Busca o local no mapa
                };
            }
            acc[group].servicos.push(item);
        }
        return acc;
    }, {});
    const servicosPorTombamento = Object.values(servicosPorTombamentoMap);
    
    // --- Opções de Filtro Dinâmicas ---
    const getOptionsFrom = (dataSet, key) => [...new Set(dataSet.map(row => row[key]).filter(Boolean))];

    const opcoesFiltro = {
        ano: getOptionsFrom(allData, 'ANO'),
        mes: getOptionsFrom(allData.filter(r => (!ano || r['ANO'] == ano)), 'MES'),
        orcamento: getOptionsFrom(allData, ORCAMENTO_COL),
    };

    res.json({
        kpis: {
            valorTotal: valorTotalGasto.toFixed(2),
            valorOrcado: valorOrcado.toFixed(2),
            qtdServicos: quantidadeServicos
        },
        graficos: {
            gastoPorDepartamento,
            valorPorTombamento,      // ALTERADO: Enviando a nova estrutura
            servicosPorTombamento,   // ALTERADO: Enviando a nova estrutura
        },
        opcoesFiltro,
    });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor do Dashboard de Orçamento rodando na porta ${PORT}`);
});
