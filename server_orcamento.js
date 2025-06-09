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

let cachedData = null; 

function cleanCurrency(value) {
    if (typeof value !== 'string') return 0;
    const cleanedValue = value.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
    const number = parseFloat(cleanedValue);
    return isNaN(number) ? 0 : number;
}

async function getSheetData() {
    if (cachedData) return cachedData;
    
    try {
        console.log("Orçamento: Buscando dados da planilha...");
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'BD_ORCAM!A:Z',
        });
        
        const rows = response.data.values;
        if (!rows || rows.length < 2) return [];

        const header = rows[0].map(h => h ? h.trim() : 'UNKNOWN_COLUMN');
        const data = rows.slice(1).map(row => {
            let obj = {};
            header.forEach((key, i) => { obj[key] = row[i]; });
            return obj;
        });

        cachedData = data;
        setTimeout(() => { cachedData = null; }, 300000); 
        return data;
    } catch (error) {
        console.error("Orçamento: Erro fatal ao buscar dados da planilha:", error.message);
        return []; 
    }
}

// =================================================================
// ROTA ÚNICA E INTELIGENTE PARA O DASHBOARD DE ORÇAMENTO
// =================================================================
app.get('/api/orcamento-data', async (req, res) => {
    let allData = await getSheetData();
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

    const valorPorTombamento = filteredData.reduce((acc, row) => {
        const group = row['TOMBAMENTO'];
        if (group) acc[group] = (acc[group] || 0) + cleanCurrency(row['VALOR TOTAL']);
        return acc;
    }, {});
    
    // ** LÓGICA ATUALIZADA AQUI **
    // Agora agrupa a lista de itens, em vez de apenas contar.
    const servicosPorTombamento = filteredData.reduce((acc, row) => {
        const group = row['TOMBAMENTO'];
        const item = row['ITEM'];
        if (group && item) {
            if (!acc[group]) {
                acc[group] = []; // Inicializa como um array
            }
            acc[group].push(item); // Adiciona o item à lista
        }
        return acc;
    }, {});

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
            valorPorTombamento,
            servicosPorTombamento,
        },
        opcoesFiltro,
    });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor do Dashboard de Orçamento rodando na porta ${PORT}`);
});
