const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const dbPath = path.resolve(__dirname, './database.sqlite');
const db = new sqlite3.Database(dbPath);

const exportDir = path.resolve(__dirname, './exports');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubmed_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        pub_date TEXT,
        search_id INTEGER,
        FOREIGN KEY (search_id) REFERENCES search_history(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        affiliation TEXT,
        is_non_academic BOOLEAN DEFAULT 0,
        company TEXT,
        email TEXT,
        paper_id INTEGER,
        FOREIGN KEY (paper_id) REFERENCES papers(id)
      )
    `);
  });
}

function logSearch(query) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO search_history (query) VALUES (?)',
      [query],
      function(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function storePaper(paper, searchId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM papers WHERE pubmed_id = ?', [paper.pubmedId], (err, existingPaper) => {
      if (err) return reject(err);
      
      if (existingPaper) {
        resolve(existingPaper.id);
      } else {
        db.run(
          'INSERT INTO papers (pubmed_id, title, pub_date, search_id) VALUES (?, ?, ?, ?)',
          [paper.pubmedId, paper.title, paper.pubDate, searchId],
          function(err) {
            if (err) return reject(err);
            
            const paperId = this.lastID;
            
            const authorPromises = [];
            
            for (let i = 0; i < paper.nonAcademicAuthors.length; i++) {
              const author = paper.nonAcademicAuthors[i];
              const company = paper.companyAffiliations[i] || null;
              
              const promise = new Promise((resolve, reject) => {
                db.run(
                  'INSERT INTO authors (name, affiliation, is_non_academic, company, email, paper_id) VALUES (?, ?, ?, ?, ?, ?)',
                  [author, 'Company', 1, company, paper.correspondingEmail, paperId],
                  function(err) {
                    if (err) return reject(err);
                    resolve();
                  }
                );
              });
              
              authorPromises.push(promise);
            }
            
            Promise.all(authorPromises)
              .then(() => resolve(paperId))
              .catch(reject);
          }
        );
      }
    });
  });
}

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const SEARCH_URL = `${BASE_URL}/esearch.fcgi`;
const FETCH_URL = `${BASE_URL}/efetch.fcgi`;

const COMPANY_KEYWORDS = [
  'pharma', 'biotech', 'therapeutics', 'inc', 'llc', 'ltd', 'corp', 'corporation', 
  'company', 'laboratories', 'gmbh', 'ag', 'plc', 'co.', 'biopharma', 'biosciences',
  'pharmaceutical', 'pharmaceuticals', 'diagnostics', 'technologies', 'oncology'
];

const ACADEMIC_KEYWORDS = [
  'university', 'college', 'hospital', 'clinic', 'institute', 'school', 'center', 
  'centre', 'medical center', 'faculty', 'department', 'division', 'laboratory of',
  'academy', 'association', 'foundation', 'national', 'federal', 'health service'
];

async function searchPubMed(query, maxResults = 100) {
  try {
    const searchParams = new URLSearchParams({
      db: 'pubmed',
      term: query,
      retmax: maxResults,
      retmode: 'json',
      sort: 'relevance'
    });
    
    const searchResponse = await fetch(`${SEARCH_URL}?${searchParams}`);
    
    if (!searchResponse.ok) {
      throw new Error(`PubMed search failed: ${searchResponse.statusText}`);
    }
    
    const searchData = await searchResponse.json();
    const pubmedIds = searchData.esearchresult.idlist || [];
    
    if (pubmedIds.length === 0) {
      return [];
    }
    
    const fetchParams = new URLSearchParams({
      db: 'pubmed',
      id: pubmedIds.join(','),
      retmode: 'xml',
      rettype: 'abstract'
    });
    
    const fetchResponse = await fetch(`${FETCH_URL}?${fetchParams}`);
    
    if (!fetchResponse.ok) {
      throw new Error(`Failed to fetch paper details: ${fetchResponse.statusText}`);
    }
    
    const xmlText = await fetchResponse.text();
    const xmlData = await parseStringPromise(xmlText, { explicitArray: false });
    
    return processPubMedResults(xmlData);
  } catch (error) {
    console.error('Error in PubMed API request:', error);
    throw error;
  }
}

function processPubMedResults(xmlData) {
  const articles = xmlData.PubmedArticleSet.PubmedArticle;
  
  if (!articles) {
    return [];
  }
  
  const articlesArray = Array.isArray(articles) ? articles : [articles];
  
  const processedResults = articlesArray
    .map(article => {
      const medlineCitation = article.MedlineCitation;
      const pubmedData = article.PubmedData;
      
      const pubmedId = medlineCitation.PMID._;
      const article_data = medlineCitation.Article;
      
      if (!article_data) {
        return null;
      }
      
      const title = article_data.ArticleTitle;
      
      let pubDate = 'Unknown';
      if (pubmedData && pubmedData.History && pubmedData.History.PubMedPubDate) {
        const pubDates = Array.isArray(pubmedData.History.PubMedPubDate) 
          ? pubmedData.History.PubMedPubDate 
          : [pubmedData.History.PubMedPubDate];
        
        const pubmedDate = pubDates.find(date => date.$.PubStatus === 'pubmed');
        
        if (pubmedDate) {
          pubDate = `${pubmedDate.Year || ''}${pubmedDate.Month ? '-' + pubmedDate.Month : ''}${pubmedDate.Day ? '-' + pubmedDate.Day : ''}`;
        }
      }
      
      const authorList = article_data.AuthorList;
      if (!authorList || !authorList.Author) {
        return null;
      }
      
      const authors = Array.isArray(authorList.Author) ? authorList.Author : [authorList.Author];
      
      const nonAcademicAuthors = [];
      const companyAffiliations = [];
      let correspondingEmail = null;
      
      authors.forEach(author => {
        const name = getAuthorName(author);
        const affiliations = getAuthorAffiliations(author);
        
        if (author.AffiliationInfo && author.AffiliationInfo.Affiliation && !correspondingEmail) {
          const affiliationText = Array.isArray(author.AffiliationInfo.Affiliation) 
            ? author.AffiliationInfo.Affiliation.join(' ') 
            : author.AffiliationInfo.Affiliation;
          
          const emailMatch = affiliationText.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
          if (emailMatch) {
            correspondingEmail = emailMatch[0];
          }
        }
        
        const isNonAcademic = checkNonAcademicAffiliation(affiliations);
        
        if (isNonAcademic) {
          nonAcademicAuthors.push(name);
          companyAffiliations.push(extractCompanyName(affiliations));
        }
      });
      
      if (nonAcademicAuthors.length === 0) {
        return null;
      }
      
      return {
        pubmedId,
        title,
        pubDate,
        nonAcademicAuthors,
        companyAffiliations,
        correspondingEmail
      };
    })
    .filter(result => result !== null);
  
  return processedResults;
}

function getAuthorName(author) {
  const lastName = author.LastName || '';
  const foreName = author.ForeName || '';
  const initials = author.Initials || '';
  
  if (lastName && foreName) {
    return `${lastName} ${foreName}`;
  } else if (lastName && initials) {
    return `${lastName} ${initials}`;
  } else if (author.CollectiveName) {
    return author.CollectiveName;
  } else {
    return lastName || 'Unknown Author';
  }
}

function getAuthorAffiliations(author) {
  if (!author.AffiliationInfo) {
    return [];
  }
  
  if (Array.isArray(author.AffiliationInfo)) {
    return author.AffiliationInfo.map(aff => aff.Affiliation).filter(Boolean);
  } else if (author.AffiliationInfo.Affiliation) {
    const affiliation = author.AffiliationInfo.Affiliation;
    return Array.isArray(affiliation) ? affiliation : [affiliation];
  }
  
  return [];
}

function checkNonAcademicAffiliation(affiliations) {
  if (!affiliations || affiliations.length === 0) {
    return false;
  }
  
  for (const affiliation of affiliations) {
    const isAcademic = ACADEMIC_KEYWORDS.some(keyword => 
      affiliation.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (isAcademic) {
      continue; // Skip this affiliation
    }
    
    const isCompany = COMPANY_KEYWORDS.some(keyword => 
      affiliation.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (isCompany) {
      return true; // Found a company affiliation
    }
  }
  
  return false;
}

function extractCompanyName(affiliations) {
  if (!affiliations || affiliations.length === 0) {
    return '';
  }
  
  for (const affiliation of affiliations) {
    const isAcademic = ACADEMIC_KEYWORDS.some(keyword => 
      affiliation.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (isAcademic) {
      continue;
    }
    
    for (const keyword of COMPANY_KEYWORDS) {
      const pattern = new RegExp(`([A-Z][A-Za-z0-9.-]+\\s+)?(${keyword}\\s+)?([A-Z][A-Za-z0-9.-]+)(\\s+${keyword})?`, 'i');
      const match = affiliation.match(pattern);
      
      if (match) {
        return match[0].trim();
      }
    }
    
    const parts = affiliation.split(',');
    return parts[0].trim();
  }
  
  return 'Unknown Company';
}

async function generateCsv(papers, filename) {
  if (!papers || papers.length === 0) {
    throw new Error('No papers provided for CSV generation');
  }

  if (!filename) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    filename = `pubmed_papers_${timestamp}.csv`;
  }

  const outputPath = path.resolve(exportDir, filename);

  const records = [];
  papers.forEach(paper => {
    if (paper.nonAcademicAuthors.length > 0) {
      for (let i = 0; i < paper.nonAcademicAuthors.length; i++) {
        records.push({
          PubmedID: paper.pubmedId,
          Title: paper.title,
          'Publication Date': paper.pubDate,
          'Non-academic Author': paper.nonAcademicAuthors[i],
          'Company Affiliation': paper.companyAffiliations[i] || '',
          'Corresponding Author Email': paper.correspondingEmail || ''
        });
      }
    } else {
      records.push({
        PubmedID: paper.pubmedId,
        Title: paper.title,
        'Publication Date': paper.pubDate,
        'Non-academic Author': '',
        'Company Affiliation': '',
        'Corresponding Author Email': paper.correspondingEmail || ''
      });
    }
  });

  const csvWriter = createObjectCsvWriter({
    path: outputPath,
    header: [
      { id: 'PubmedID', title: 'PubmedID' },
      { id: 'Title', title: 'Title' },
      { id: 'Publication Date', title: 'Publication Date' },
      { id: 'Non-academic Author', title: 'Non-academic Author(s)' },
      { id: 'Company Affiliation', title: 'Company Affiliation(s)' },
      { id: 'Corresponding Author Email', title: 'Corresponding Author Email' }
    ]
  });

  await csvWriter.writeRecords(records);

  return {
    filename,
    path: outputPath,
    recordCount: records.length
  };
}

app.get('/api/papers', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const searchId = await logSearch(query);

    const papers = await searchPubMed(query);

    const storePromises = papers.map(paper => storePaper(paper, searchId));
    await Promise.all(storePromises);

    res.json(papers);
  } catch (error) {
    console.error('Error in search papers:', error);
    res.status(500).json({ error: `Failed to search papers: ${error.message}` });
  }
});

app.post('/api/papers/download', async (req, res) => {
  const { results } = req.body;

  if (!results || !Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'Valid paper results are required' });
  }

  try {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const filename = `pubmed_papers_${timestamp}.csv`;

    const csvResult = await generateCsv(results, filename);

    res.setHeader('Content-Disposition', `attachment; filename="${csvResult.filename}"`);
    res.setHeader('Content-Type', 'text/csv');

    const fileStream = fs.createReadStream(csvResult.path);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.unlink(csvResult.path, (err) => {
        if (err) console.error('Failed to delete temporary CSV file:', err);
      });
    });
  } catch (error) {
    console.error('Error in download papers controller:', error);
    res.status(500).json({ error: `Failed to generate CSV: ${error.message}` });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong' 
  });
});

initializeDatabase();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`API available at http://localhost:${PORT}/api/papers`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
}); 
