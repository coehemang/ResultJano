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
  return await puppeteer.launch({ 
    headless: true, 
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,720'
    ]
  });
};

const processRolls = async (browser, rolls, websiteURL, semesterType, academicYear, romanSemester, branch, jobId) => {
  console.log(`Processing ${rolls.length} roll numbers`);
  const results = {};
  const jobDir = getJobDownloadDir(jobId);
  
  const CONCURRENT_WORKERS = 3;
  const BATCH_SIZE = Math.min(50, rolls.length);
  
  console.log(`Using ${CONCURRENT_WORKERS} concurrent workers with batch size ${BATCH_SIZE}`);
  
  try {
    for (let batchStart = 0; batchStart < rolls.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, rolls.length);
      console.log(`Processing batch from index ${batchStart} to ${batchEnd-1}`);
      
      const batchRolls = rolls.slice(batchStart, batchEnd);
      let currentIndex = 0;
      
      const workers = Array.from({ length: CONCURRENT_WORKERS }, async (_, workerIndex) => {
        const page = await browser.newPage();
        console.log(`Worker ${workerIndex+1}: Created new page`);
        
        try {
          page._dialogShown = false; 
          
          page.on('dialog', async dialog => {
            try {
              console.log(`Worker ${workerIndex+1}: Dialog detected: "${dialog.message()}"`);
              page._dialogShown = true;
              
              await dialog.accept().catch(err => {
                console.log(`Worker ${workerIndex+1}: Dialog handling note: ${err.message}`);
              });
            } catch (err) {
              console.log(`Worker ${workerIndex+1}: Error handling dialog: ${err.message}`);
            }
          });
          
          const client = await page.target().createCDPSession();
          await client.send('Page.setDownloadBehavior', { 
            behavior: 'allow', 
            downloadPath: jobDir 
          });
          
          await page.setRequestInterception(true);
          page.on('request', request => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
              request.abort();
            } else {
              request.continue();
            }
          });

          console.log(`Worker ${workerIndex+1}: Navigating to ${websiteURL}`);
          await page.goto(websiteURL, { waitUntil: 'domcontentloaded' });
          
          await page.click(`#link${semesterType}Sem${academicYear}`);
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {});
          
          const clicked = await page.evaluate((romanSem, branchName) => {
            const links = Array.from(document.querySelectorAll('a'));
            for (const link of links) {
              if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && 
                  link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
                link.click(); 
                return true;
              }
            }
            return false;
          }, romanSemester, branch);

          if (!clicked) {
            console.log(`Worker ${workerIndex+1}: Failed to find link for ${romanSemester} semester and ${branch}`);
            return;
          }

          await page.waitForSelector('#txtRollNo', { timeout: 5000 }).catch(() => {});
          
          while (true) {
            const rollIndex = currentIndex++;
            if (rollIndex >= batchRolls.length) break;
            
            const roll = batchRolls[rollIndex];
            jobStore[jobId].lastProcessedRoll = roll;
            console.log(`Worker ${workerIndex+1}: Processing roll ${roll} (${batchStart + rollIndex + 1}/${rolls.length})`);
            
            try {
              page._dialogShown = false;
              
              await page.evaluate(() => document.querySelector('#txtRollNo').value = '');
              await page.type('#txtRollNo', roll);
              
              await page.click('#btnGetResult');
              
              await delay(1000);
              
              let success = false;
              
              if (!page._dialogShown) {
                const startTime = Date.now();
                const checkInterval = 100;
                const maxWaitTime = 3000;
                
                while (Date.now() - startTime < maxWaitTime) {
                  await delay(checkInterval);
                  const files = await fs.promises.readdir(jobDir);
                  const pdfFiles = files.filter(f => f.endsWith('.pdf'));
                  if (pdfFiles.length > 0) {
                    success = true;
                    break;
                  }
                }
              }
              
              // Update job status
              results[roll] = success;
              jobStore[jobId].completed++;
              
              if (success) {
                console.log(`Worker ${workerIndex+1}: Success for roll ${roll}`);
                jobStore[jobId].successful.push(roll);
              } else {
                console.log(`Worker ${workerIndex+1}: No result for roll ${roll} ${page._dialogShown ? '(dialog shown)' : '(no download)'}`);
                jobStore[jobId].notFound.push(roll);
              }
              
              console.log(`Progress: ${jobStore[jobId].completed}/${jobStore[jobId].total} rolls processed`);
              
              // Small delay between rolls to prevent rate limiting
              await delay(300);
              
            } catch (error) {
              console.error(`Worker ${workerIndex+1}: Error processing roll ${roll}:`, error);
              jobStore[jobId].notFound.push(roll);
              jobStore[jobId].completed++;
              
              
              try {
                await page.goto(websiteURL, { waitUntil: 'domcontentloaded' });
                await page.click(`#link${semesterType}Sem${academicYear}`);
                await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {});
                
                await page.evaluate((romanSem, branchName) => {
                  const links = Array.from(document.querySelectorAll('a'));
                  for (const link of links) {
                    if (link.textContent.toLowerCase().includes(romanSem.toLowerCase()) && 
                        link.textContent.toLowerCase().includes(branchName.toLowerCase())) {
                      link.click(); 
                      return true;
                    }
                  }
                  return false;
                }, romanSemester, branch);
                
                await page.waitForSelector('#txtRollNo', { timeout: 5000 }).catch(() => {});
              } catch (navigationError) {
                console.error(`Worker ${workerIndex+1}: Failed to reload page after error:`, navigationError);
              }
            }
          }
        } catch (err) {
          console.error(`Worker ${workerIndex+1}: Fatal error:`, err);
        } finally {
          // Remove all listeners before closing the page
          page.removeAllListeners();
          console.log(`Worker ${workerIndex+1}: Closing page`);
          await page.close().catch(() => {});
        }
      });
      
      await Promise.all(workers);
      console.log(`Completed batch from index ${batchStart} to ${batchEnd-1}`);
    }
  } catch (err) {
    console.error(`Error in batch processing:`, err);
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

    const rolls = Array.from(
      { length: end - start + 1 }, 
      (_, i) => `${prefix}${(start + i).toString().padStart(4, '0')}`
    );
    
    jobStore[jobId].currentStep = 'processing_rolls';
    
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
      
      await deleteJobFolder(jobId);
    }
  } catch (err) {
    console.error(`Fatal error in job ${jobId}:`, err);
    jobStore[jobId].status = 'error';
    jobStore[jobId].error = err.message;
    jobStore[jobId].currentStep = 'error';
    jobStore[jobId].endTime = Date.now();
    
    await deleteJobFolder(jobId);
  }
});

app.post('/cancel/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  console.log(`Received cancellation request for job: ${jobId}`);
  
  const job = jobStore[jobId];
  if (!job) {
    console.log(`Job ${jobId} not found for cancellation`);
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (job.status !== 'pending') {
    console.log(`Cannot cancel job ${jobId} with status ${job.status}`);
    return res.status(400).json({ error: 'Job cannot be cancelled in its current state' });
  }
  
  try {
    job.status = 'canceled';
    job.currentStep = 'canceled';
    job.endTime = Date.now();
    
    console.log(`Job ${jobId} marked as canceled`);
    
    await deleteJobFolder(jobId);
    console.log(`Resources cleaned up for canceled job ${jobId}`);
    
    res.json({ success: true, message: 'Job canceled successfully' });
  } catch (err) {
    console.error(`Error canceling job ${jobId}:`, err);
    res.status(500).json({ error: 'Failed to cancel job', message: err.message });
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


