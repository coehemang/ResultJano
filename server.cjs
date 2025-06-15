const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { mergePDFs } = require('./utils/mergePDFs.cjs');

const app = express();
const PORT = process.env.PORT || 5002;

console.log('Initializing server...');
const downloadsBaseDir = path.join(__dirname, 'downloads');
const mergedDir = path.join(__dirname, 'merged');
const publicDir = path.join(__dirname, 'public');

[downloadsBaseDir, mergedDir, publicDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    console.log(`Creating directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(cors());
app.use(express.json());
app.use('/merged', express.static(mergedDir));
app.use(express.static(publicDir));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jobStore = {};

const getJobDownloadDir = (jobId) => {
  return path.join(downloadsBaseDir, `job_${jobId}`);
};

const ensureJobDir = async (jobId) => {
  const jobDir = getJobDownloadDir(jobId);
  if (!fs.existsSync(jobDir)) {
    console.log(`Creating job directory: ${jobDir}`);
    fs.mkdirSync(jobDir, { recursive: true });
  }
  return jobDir;
};

const waitForDownload = async (roll, jobId, timeoutMs = 10000) => {
  const jobDir = getJobDownloadDir(jobId);
  console.log(`Waiting for download of roll ${roll} in ${jobDir}, timeout: ${timeoutMs}ms`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const files = await fs.promises.readdir(jobDir);
    if (files.length > 0) {
      console.log(`Download completed for roll ${roll}`);
      return true;
    }
    await delay(500);
  }
  console.log(`Download timeout for roll ${roll}`);
  return false;
};

const cleanFolder = async folder => {
  if (!fs.existsSync(folder)) {
    console.log(`Folder doesn't exist, skipping cleanup: ${folder}`);
    return;
  }
  
  console.log(`Cleaning folder: ${folder}`);
  const files = await fs.promises.readdir(folder);
  console.log(`Found ${files.length} files to clean`);
  await Promise.all(files.map(file => fs.promises.unlink(path.join(folder, file))));
  console.log(`Folder ${folder} cleaned successfully`);
};

const deleteJobFolder = async (jobId) => {
  const jobDir = getJobDownloadDir(jobId);
  if (fs.existsSync(jobDir)) {
    console.log(`Deleting job folder: ${jobDir}`);
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    console.log(`Job folder deleted: ${jobDir}`);
  }
};

const toRomanNumeral = num => {
  const romanNumerals = { 1: 'Ist', 2: 'IInd', 3: 'IIIrd', 4: 'IVth', 5: 'Vth', 6: 'VIth', 7: 'VIIth', 8: 'VIIIth' };
  return romanNumerals[num] || num.toString();
};

const createBrowser = async () => {
  console.log('Launching Puppeteer browser');
  return await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
};

const processRolls = async (browser, rolls, websiteURL, semesterType, academicYear, romanSemester, branch, jobId) => {
  console.log(`Processing ${rolls.length} roll numbers`);
  const results = {};
  const jobDir = getJobDownloadDir(jobId);
  let page;
  
  try {
    page = await browser.newPage();
    console.log(`New page created for batch processing`);
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: jobDir });

    console.log(`Navigating to ${websiteURL}`);
    await page.goto(websiteURL, { waitUntil: 'networkidle2' });
    
    console.log(`Clicking on ${semesterType}Sem${academicYear}`);
    await page.click(`#link${semesterType}Sem${academicYear}`);
    await delay(2000);

    console.log(`Attempting to find and click ${romanSemester} semester for ${branch}`);
    const clicked = await page.evaluate((romanSem, branchName) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
          link.click(); return true;
        }
      }
      return false;
    }, romanSemester, branch);

    if (!clicked) {
      console.log(`Failed to find link for ${romanSemester} semester and ${branch}`);
      return {};
    }

    await delay(2000);
    await page.waitForSelector('#txtRollNo');
    
    for (let i = 0; i < rolls.length; i++) {
      const roll = rolls[i];
      jobStore[jobId].lastProcessedRoll = roll; // Track current roll
      console.log(`Processing roll ${roll} (${i+1}/${rolls.length})`);
      
      await page.evaluate(() => document.querySelector('#txtRollNo').value = '');
      await page.type('#txtRollNo', roll);
      
      const dialogPromise = new Promise(resolve => {
        page.once('dialog', async dialog => {
          console.log(`Dialog appeared: ${dialog.message()}`);
          await dialog.accept();
          resolve(true);
        });
        setTimeout(() => resolve(false), 8000);
      });

      console.log(`Clicking get result button for ${roll}`);
      
      const beforeFiles = await fs.promises.readdir(jobDir);
      
      await Promise.all([
        page.click('#btnGetResult'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {
          console.log('Navigation timeout - this can be normal if download started');
        })
      ]);

      const dialog = await dialogPromise;
      let success = false;
      
      if (!dialog) {
        success = await waitForDownload(roll, jobId);
      } else {
        console.log(`Dialog detected for roll ${roll}, no result available`);
      }
      
      results[roll] = success;
      jobStore[jobId].completed++;
      
      if (success) {
        console.log(`Successfully processed roll ${roll}`);
        jobStore[jobId].successful.push(roll);
      } else {
        console.log(`No result found for roll ${roll}`);
        jobStore[jobId].notFound.push(roll);
      }
      
      console.log(`Progress: ${jobStore[jobId].completed}/${jobStore[jobId].total} rolls processed`);
      
      await delay(800);
    }
  } catch (err) {
    console.error(`Error in batch processing:`, err);
  } finally {
    if (page) {
      console.log(`Closing page after batch processing`);
      await page.close();
    }
  }
  
  return results;
};

app.post('/result', async (req, res) => {
  console.log('Received /result request:', req.body);
  const { startRoll, endRoll, academicYear, semester, semesterType, branch } = req.body;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const start = parseInt(startRoll.slice(-4));
  const end = parseInt(endRoll.slice(-4));
  const prefix = startRoll.slice(0, -4);
  const total = end - start + 1;

  console.log(`Creating job ${jobId} for rolls ${startRoll} to ${endRoll}, total: ${total}`);
  // Enhanced job store with more details
  jobStore[jobId] = { 
    status: 'pending', 
    completed: 0, 
    total, 
    notFound: [], 
    successful: [],
    startTime: Date.now(),
    lastProcessedRoll: null,
    currentStep: 'initializing',
    config: {
      startRoll,
      endRoll,
      academicYear,
      semester,
      semesterType,
      branch
    }
  };
  res.json({ jobId });

  try {
    const jobDir = await ensureJobDir(jobId);
    console.log(`Using job directory: ${jobDir}`);
    
    const browser = await createBrowser();
    const websiteURL = 'https://mbmiums.in/(S(zkvqtk0qyp2cyqpl4smvkq45))/Results/ExamResult.aspx';
    const romanSemester = toRomanNumeral(parseInt(semester));
    console.log(`Using roman semester: ${romanSemester}`);

    await cleanFolder(mergedDir);

    // Generate all roll numbers first
    const rolls = [];
    for (let i = start; i <= end; i++) {
      rolls.push(`${prefix}${i.toString().padStart(4, '0')}`);
    }
    
    jobStore[jobId].currentStep = 'processing_rolls';
    // Process all rolls with a single page
    await processRolls(browser, rolls, websiteURL, semesterType, academicYear, romanSemester, branch, jobId);

    console.log('Closing browser');
    await browser.close();

    const mergedFile = `Merged_result_${jobId}.pdf`;
    const mergedPath = path.join(mergedDir, mergedFile);

    try {
      jobStore[jobId].currentStep = 'merging_pdfs';
      console.log(`Starting PDF merge from ${jobDir} to ${mergedPath}`);
      await mergePDFs(jobDir, mergedPath);
      console.log(`PDFs successfully merged to ${mergedPath}`);
      
      await deleteJobFolder(jobId);
      
      jobStore[jobId].status = 'done';
      jobStore[jobId].currentStep = 'complete';
      jobStore[jobId].endTime = Date.now();
      jobStore[jobId].downloadURL = `/merged/${mergedFile}`;
      console.log(`Job ${jobId} completed successfully`);
    } catch (err) {
      console.error(`PDF merge error:`, err);
      jobStore[jobId].status = 'error';
      jobStore[jobId].error = err.message;
      jobStore[jobId].currentStep = 'error';
      jobStore[jobId].endTime = Date.now();
      
      // Still try to clean up in case of error
      await deleteJobFolder(jobId);
    }
  } catch (err) {
    console.error(`Fatal error in job ${jobId}:`, err);
    jobStore[jobId].status = 'error';
    jobStore[jobId].error = err.message;
    jobStore[jobId].currentStep = 'error';
    jobStore[jobId].endTime = Date.now();
    
    // Clean up in case of error
    await deleteJobFolder(jobId);
  }
});

app.get('/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  console.log(`Status check for job: ${jobId}`);
  const job = jobStore[jobId];
  if (!job) {
    console.log(`Job ${jobId} not found`);
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const now = Date.now();
  const elapsedMs = now - job.startTime;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const elapsedMinutes = elapsedSeconds / 60;
  
  let speed = 0;
  if (job.completed > 0 && elapsedSeconds > 0) {
    speed = (job.completed / elapsedSeconds) * 60;
  }
  
  let estimatedTimeRemaining = null;
  if (speed > 0 && job.total > job.completed) {
    const remainingRolls = job.total - job.completed;
    estimatedTimeRemaining = remainingRolls / speed;
  }
  
  const progressPercent = job.total > 0 ? 
    `${Math.round((job.completed / job.total) * 100)}%` : '0%';
  
  const enhancedResponse = {
    ...job,
    progress: `${job.completed}/${job.total} (${progressPercent})`,
    progressPercent,
    elapsedTime: {
      seconds: elapsedSeconds,
      minutes: elapsedMinutes.toFixed(2),
      formatted: formatTime(elapsedSeconds)
    },
    processingSpeed: {
      rollsPerMinute: speed.toFixed(2)
    },
    estimatedTimeRemaining: estimatedTimeRemaining ? 
      {
        minutes: estimatedTimeRemaining.toFixed(2),
        formatted: formatTime(Math.round(estimatedTimeRemaining * 60))
      } : null,
    successfulCount: job.successful.length,
    notFoundCount: job.notFound.length,
    recentSuccessful: job.successful.slice(-10).reverse(),
    recentNotFound: job.notFound.slice(-10).reverse()
  };
  
  console.log(`Returning enhanced status for job ${jobId}: ${job.status}, progress: ${job.completed}/${job.total}`);
  res.json(enhancedResponse);
});

function formatTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  return [
    hours > 0 ? String(hours).padStart(2, '0') : null,
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].filter(Boolean).join(':');
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
