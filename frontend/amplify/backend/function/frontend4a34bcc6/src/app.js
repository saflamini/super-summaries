/*
Copyright 2017 - 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at
    http://aws.amazon.com/apache2.0/
or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and limitations under the License.
*/

// import express, { response } from 'express';
// import https from "https";
// import multer from 'multer';
const multer = require('multer');
// import fs from 'fs';
const fs = require('fs');
// import path from 'path';
const path = require('path');
// import axios from 'axios';
const axios = require('axios');
// import ffmpeg from 'fluent-ffmpeg';
const { ffmpeg } = require('fluent-ffmpeg');
// import cors from 'cors';
const cors = require('cors')
// import { Configuration, OpenAIApi } from 'openai';
const { Configuration, OpenAIApi } = require('openai');
// import { encoding_for_model } from '@dqbd/tiktoken';
const { encoding_for_model } = require('@dqbd/tiktoken');
// import { spawn } from 'child_process';
const { spawn } = require('child_process');
// import AWS from "aws-sdk";
const AWS = require('aws-sdk');


// import dotenv from 'dotenv';
const dotenv = require('dotenv')
dotenv.config();



const express = require('express')
const bodyParser = require('body-parser')
const awsServerlessExpressMiddleware = require('aws-serverless-express/middleware')


//LOTS OF FUNCTIONS AND GLOBAL VARIABLES 
//********************************* */
// Create an Amazon S3 object.
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS,
  secretAccessKey: process.env.AWS_SECRET_ACCESS,
  signatureVersion: 'v4',
  region: 'us-east-2'
});

const generatePresignedUrl = (operation, params) => {
  return new Promise((resolve, reject) => {
    s3.getSignedUrl(operation, params, (err, url) => {
      if (err) {
        reject(err);
      } else {
        resolve(url);
      }
    });
  });
};

async function createPresignedUrl(parameters) {
  const url = await generatePresignedUrl('getObject', parameters);

  console.log('The URL is', url);
  return url;
}

// const privateKey = fs.readFileSync('./backend/server.key', 'utf8');
// const certificate = fs.readFileSync('./backend/server.crt ', 'utf8');
const certPath = '/Users/sam_flamini/devPortfolio/super-summaries/backend/server.crt';
const keyPath = '/Users/sam_flamini/devPortfolio/super-summaries/backend/server.key';

const certificate = fs.readFileSync(certPath, 'utf-8');
const privateKey = fs.readFileSync(keyPath, 'utf-8');
const passphrase = process.env.PASSPHRASE;

const sslOptions = {
  key: privateKey,
  cert: certificate,
  passphrase: passphrase
};
//SET UP ASSEMBLY AI
const assembly = axios.create({
  baseURL: "https://api.assemblyai.com/v2",
  headers: {
      authorization: process.env.ASSEMBLY_KEY,
  },
});

//SET UP OPENAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

//HELPERS
function convertTimestampToSeconds(timestamp) {            
  const [mmss, ms] = timestamp.split(".");            
  const [mm, ss] = mmss.split(":").map(parseFloat);
  const milliseconds = parseFloat(ms) || 0;
  return (mm * 60) + ss + (milliseconds / 1000);
}

function splitChapterFromVtt(chapter, vttContent) {
  let output = "";

  const [webvttLine, ...restOfContent] = vttContent.split("\n");
  const adjustedVtt = restOfContent.join("\n"); // "\n00:00.000 --> 00:05.000\nHello World!"

  const startSeconds = chapter.start / 1000;
  const endSeconds = chapter.end / 1000;
  adjustedVtt.split("\n\n").forEach((block) => {
    const [timecode, ...lines] = block.split("\n");
    const [startTime, endTime] = timecode.split(" --> ");
    let start;
    let end;
    if (startTime.length > 0 && endTime.length > 0) {
      start = convertTimestampToSeconds(startTime);
      end = convertTimestampToSeconds(endTime);
      if (start <= endSeconds && end >= startSeconds) {
        // output += `${timecode}\n${lines.join("\n")}\n\n`;
          output += `${timecode}\n`;
          lines.forEach((line) => {
          output += `${line}\n`;
          });
        }
      }
    });
    return output;
  }

  function splitChaptersFromVtt(chapters, vtt) {
    for (let i = 0; i < chapters.length; i++) {
      chapters[i].vtt = splitChapterFromVtt(chapters[i], vtt);
    }
    return chapters;
  }

  function formatTimestamp(inputString) {
    return inputString.replace(/[:.]/g, '');
  }

  function removeLongChapters(chapters) {
    let newChapters = chapters.filter(chapter => chapter.end - chapter.start <= 360000);
    return newChapters;
  }

  function countTokensInPrompt(chapter) {
    let gptEnc = encoding_for_model("gpt-3.5-turbo");          
    let tokenCounter =  gptEnc.encode(chapter.prompt).length;
    console.log("Tokens in prompt", tokenCounter);
  }

  function extractTimes(inputChapter) {
    let chapter = inputChapter;
    let text = chapter.lastCompletion;
    const startTimeMatch = text.match(/Start time: (\d{2}:\d{2}\.\d{3})/);
    const endTimeMatch = text.match(/End time: (\d{2}:\d{2}\.\d{3})/);

    let startTime;
    let endTime;
    if (startTimeMatch && endTimeMatch) {
      startTime = startTimeMatch[1];
      endTime = endTimeMatch[1];
      chapter.clips = [
        {
          startTime: startTime,
          endTime: endTime
        }
      ]
    } else {
      console.log("Could not extract start and end times");
    }

    return chapter;
  }
        
  function extractTimesFromChapters(chapters) {
    let chaptersWithClips = [];
    for (let i = 0; i < chapters.length; i++) {
      let newChap = extractTimes(chapters[i]);
      chaptersWithClips.push(newChap);
    }
    return chaptersWithClips;
  }

  function addPromptsToChapters(chapters) {
    for (let i = 0; i < chapters.length; i++) {
      let prompt = `
      I am going to give you a transcript formatted as VTT file, and it will be your job to pull out a clip that is between 45 seconds and 59 seconds. Based on the text content I paste below, please tell me the start time and end time of a clip that will make for an engaging youtube short. This clip must be at least 45 seconds long. This means that, if we were to subtract the start time from the end time, we must get a value of at least 45. Also, please do not give me a clip that starts or ends mid sentence. The clip of text must feel like a complete thought.

      Transcript:
      ${chapters[i].vtt}
      End transcript.

      Output format:
      Clip Start time: 
      Clip End time: 

      Output:
      ${chapters[i].vtt}
      `
      chapters[i].prompt = prompt;
    }
    return chapters;
  }


  function readFileContents(file) {
    return new Promise((resolve, reject) => {
      fs.readFile(file.path, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  function readFileFromPath(filepath) {
    return new Promise((resolve, reject) => {
      fs.readFile(filepath, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }
  //API CALLS

  //this should probably be a post request to upload files to s3 bucket
  //we'll then need a second function to check the status of the upload
  const uploadFile = async (file, userId) => {

    const fileContents = await readFileContents(file);

    console.log(file)
    const fileUploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `${userId}/${file.originalname}`,
      Body: fileContents
    };

    console.log('file upload params body', fileUploadParams.Body)

    try {
      const response = await s3.upload(fileUploadParams).promise();
      console.log('File uploaded:', response.Location);
  
      // Wait for the file to be uploaded before running new logic
      const checkInterval = 5000; // Check every 5 seconds
      const maxWaitTime = 300000; // Maximum wait time of 5 minutes
      let elapsedTime = 0;
      while (elapsedTime < maxWaitTime) {
        try {
          // Check if the object exists in S3
          const headParams = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${userId}/${file.originalname}`
          };
          await s3.headObject(headParams).promise();
  
          // Get the URL of the object
          const urlParams = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${userId}/${file.originalname}`
          };
          const url = s3.getSignedUrl('getObject', urlParams);
          console.log('Object URL:', url);
  
          // Return the URL of the object
          return url;
        } catch (error) {
          console.log('Object not found yet, waiting...');
          elapsedTime += checkInterval;
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
      }
      console.log('Timed out waiting for object to be uploaded.');
    } catch (error) {
      console.error(error);
    }
  };

  
  async function checkTranscriptionStatus(transcriptId) {
    console.log('checking status of id: ', transcriptId, '...')
    const response = await assembly.get(`/transcript/${transcriptId}`);
    const status = response.data.status;
  
    if (status === 'completed') {
      return response.data;
    } else if (status === 'error') {
      throw new Error('Transcription failed');
    } else {
      // Wait for some time and then check again
      await new Promise(resolve => setTimeout(resolve, 5000));
      return checkTranscriptionStatus(transcriptId);
    }
  }
  //note that we may need to pass 'assemblyUploadURL' as a parameter to this function
  async function transcribeAudio(inputUrl) {
    console.log('Transcribing audio...');

    const presignedUrl = inputUrl

    let assemblyFileId;
    console.log('this is the file we are passing to /transcript: ', presignedUrl);
    try {
      //note that we may need to pass 'assemblyUploadURL' as a parameter to this function instead of the presignedUrl
      const response = await assembly.post('/transcript', {audio_url: presignedUrl, auto_chapters: true});
      assemblyFileId = response.data.id;
      console.log('assembly file id: ', assemblyFileId);
    } catch (error) {
      console.error('Error uploading file to Assembly:', error);
      throw error;
    }
  
    try {
      const transcriptData = await checkTranscriptionStatus(assemblyFileId);
      console.log('Transcription complete');
      return transcriptData;
    } catch (error) {
      console.error('Error checking transcription status:', error);
      throw error;
    }
  }

  async function createChapterCompletions(chapters) {
    let completion;
    let text;
    for (let i = 0; i < chapters.length; i++) {
      try {
        completion = await openai.createChatCompletion({
          model: "gpt-3.5-turbo",
          messages: [{role: "user", content: chapters[i].prompt}],
        });
        console.log(`
        Output of Chapter ${i}
        ${completion['data']['choices'][0]['message']["content"]}
        `);
        text = completion['data']['choices'][0]['message']["content"];
        chapters[i].lastCompletion = text;
      } catch (error) {
        console.log(error)
      }
    }

    return chapters;
  }

  async function getAudioVtt(assemblyFileId) {
    try {
      const response = await assembly.get(`/transcript/${assemblyFileId}/vtt`);
      const vtt = response.data;
      return vtt;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }
  
  async function getChapters(assemblyFileId) {
    try {
      const response = await assembly.get(`/transcript/${assemblyFileId}`);
      const chapters = response.data.chapters;
      return chapters;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  //WORKING WITH FILES


  // async function generateClip(chapter, filepath) {

  ////note that file will jiust be req.file
  //we won't upload it anywhere, just going to use it to generate the clips
  async function generateClip(chapter, userId, filepath) {

    const fileContents = await readFileFromPath(filepath);    
    
    return new Promise((resolve, reject) => {
         
      // get the start time, end time and filename from the request query parameters
      console.log('chapter: ', chapter.clips[0])
      let startTime = formatTimestamp(chapter.clips[0].startTime);
      let endTime = formatTimestamp(chapter.clips[0].endTime);
      const inputFileBase = path.basename(filepath, '.mp4');
      // Create a new filename for the clipped video using userId + file.originalname for folder and start/end times
      const clippedFilePath = `uploads/${inputFileBase}-${userId}-clipped-${startTime}_${endTime}.mp4`;
      
      // create a child process using ffmpeg to clip the video into multiple segments
      // and push the path of each segment into the paths array
      const ffmpeg = spawn('ffmpeg', [
        '-i',
        filepath, //note that file will just be req.file
        '-ss',
        chapter.clips[0].startTime,
        '-to',
        chapter.clips[0].endTime,
        '-c',
        'copy',
        '-map',
        '0',
        clippedFilePath,
      ]);
      
      // listen for the 'close' event to know when the child process has finished
      ffmpeg.on('close', () => {

        const clippedFilePathAbsolute = path.resolve(`uploads/${inputFileBase}-${userId}-clipped-${startTime}_${endTime}.mp4`);
        console.log('clipped file path absolute: ', clippedFilePathAbsolute);
        
        resolve(clippedFilePathAbsolute);
      });
    });
  }

  async function resizeVideo(inputFilePath, outputFilePath, size) {
    return new Promise((resolve, reject) => {
      console.log("re sizing is now under way for file", inputFilePath);
      const newOutputFilePath = path.resolve(outputFilePath);
      
      // Create a child process using ffmpeg to resize the video to a square aspect ratio
      const ffmpeg = spawn('ffmpeg', [
        '-i',
        inputFilePath,
        '-map',
        '0',
        '-vf',
        `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
        newOutputFilePath,
        '-report'
      ]);
  
      // Listen for the 'close' event to know when the child process has finished
      ffmpeg.on('close', () => {
        try {
          resolve(newOutputFilePath);
        } catch (err) {
          console.log(err)
          reject(new Error(`Failed to create resized video at ${newOutputFilePath}`));
        }
      });
    });
  }

  async function generateAndResizeClip(chapter, userId, filePath) {
    console.log('file input in gen and resize clip: ', filePath)
    try {
      const clippedFilePathAbsolute = await generateClip(chapter, userId, filePath);
      console.log(`Clipped video saved to ${clippedFilePathAbsolute}`);
      const clippedFilePathBase = path.basename(clippedFilePathAbsolute, '.mp4');
      const resizedFilePath = await resizeVideo(clippedFilePathAbsolute, `uploads/${clippedFilePathBase}-resized.mp4`, 1080);
      console.log(`Resized video saved to ${resizedFilePath}`);

      const fileContents = await readFileFromPath(resizedFilePath);

      const resizedFileNameParts = resizedFilePath.split('clipped-');
      const resizedFileNameOfficial = `${userId}/${resizedFileNameParts[1]}`;

      const fileUploadParams = {
        Bucket: process.env.AWS_OUTPUT_BUCKET_NAME,
        Key: resizedFileNameOfficial,
        Body: fileContents
      };

      // Upload the file to S3 - this should be encapsulated in a function 
      try {
        const response = await s3.upload(fileUploadParams).promise();
        console.log('File uploaded:', response.Location);
    
        // Wait for the file to be uploaded before running new logic
        const checkInterval = 5000; // Check every 3 seconds
        const maxWaitTime = 300000; // Maximum wait time of 5 minutes
        let elapsedTime = 0;
        while (elapsedTime < maxWaitTime) {
          try {
            // Check if the object exists in S3
            const headParams = {
              Bucket: process.env.AWS_OUTPUT_BUCKET_NAME,
              Key: resizedFileNameOfficial
            };
            await s3.headObject(headParams).promise();
    
            // Get the URL of the object
            const urlParams = {
              Bucket: process.env.AWS_OUTPUT_BUCKET_NAME,
              Key: resizedFileNameOfficial
            };
            const url = s3.getSignedUrl('getObject', urlParams);
            console.log('Object URL:', url);
    
            // Return the URL of the object
            return url;
          } catch (error) {
            console.log('Object not found yet, waiting...');
            elapsedTime += checkInterval;
            await new Promise(resolve => setTimeout(resolve, checkInterval));
          }
        }
        console.log('Timed out waiting for object to be uploaded.');
      } catch (error) {
        console.error(error);
      }
      return resizedFilePath;
    } catch (error) {
      console.error(error);
    }
  }

  async function generateAndResizeClips(chapters, userId, localFilePath) {
    let outputFilePaths = [];
    for (let i = 0; i < chapters.length; i++) {
      let newPath = await generateAndResizeClip(chapters[i], userId, localFilePath);
      outputFilePaths.push(newPath);
    }

    return outputFilePaths;
  }


    const uploadDir = './uploads';

    // Create the 'uploads' directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

  // Set up multer storage
  let localFileName;
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
      localFileName = `uploads/${Date.now()}-${file.originalname}`;
      cb(null, Date.now() + '-' + file.originalname);
    },
  });
  const upload = multer({
    storage: storage,
    limits: {
      fileSize: 8 * 1024 * 1024 * 1024, // 8 GB
    },
  });

  //********************* */




  const app = express();
  const corsOptions = {
    origin: '*',
  };
  app.use(cors(corsOptions));
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
app.use(bodyParser.json())
app.use(awsServerlessExpressMiddleware.eventContext())

// Enable CORS for all methods
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "*")
  next()
});


/**********************
 * Example get method *
 **********************/

app.get('/clip-video', function(req, res) {
  // Add your code here
  res.json({success: 'get call succeed!', url: req.url});
});

app.get('/clip-video/*', function(req, res) {
  // Add your code here
  res.json({success: 'get call succeed!', url: req.url});
});


/*************************** */
//Official Upload Post Method *
/*************************** */

// app.post('/upload', upload.single('file'), async (req, res) => {
  app.post('/upload', upload.single('file'), async (req, res) => {

    console.log('your message has reached the server')

    
    if (!req.file) {
      console.log('no file uploaded')
      return res.status(400).send('No file uploaded');
    }
    const userId = req.body.userId;
    // Check that the userId is not empty
    if (!userId || userId.length === 0) {
      console.log('bad or missing username');
      return res.status(400).json({ error: 'userId is required' });
    }
    
    console.log('userId: ', userId)
    // // File has been saved to disk by multer, you can use it in other parts of your application
    console.log(`File has been saved to ${req.file.path}`);

    try {
      //CORE FUNCTIONALITY
      let vtt, newChapters;
      let outputPaths;

      //STEP 0 - UPLOAD & RETRIEVE FILE FROM S3
      let s3Url = await uploadFile(req.file, userId);


      //STEP 1 - TRANSCRIBE AUDIO

      const transcriptionData = await transcribeAudio(s3Url);
      if (transcriptionData) {
        console.log('transcription complete')
      }
  
      vtt = await getAudioVtt(transcriptionData.id);
      console.log('step 2: vtt =', vtt);
  
      const chapters = await getChapters(transcriptionData.id);
      console.log('step 3: chapters =', chapters);
      //   //STEP 3 - FORMAT CHAPTERS for Clip Generation
      //   console.log('step 3');
      let newSplitChapters = splitChaptersFromVtt(chapters, vtt); //returns newChapters (with prompts)
      console.log('sample split chapter =', newSplitChapters[0]);
      let adjustedSplitChapters = removeLongChapters(newSplitChapters); //returns newChapters that exclude long chapters (i.e. over 6 mins) - this is needed for openai api
      console.log('sample adjusted split chapter =', adjustedSplitChapters[0]);
      let chaptersWithPrompts = addPromptsToChapters(adjustedSplitChapters); //returns newChapters (with prompts
      // })

      console.log('sample chapter with prompt =', chaptersWithPrompts[0]);
      // .then(async () => {
      //   //STEP 4 - GENERATE CLIP COMPLETIONS
      let chaptersWithCompletions = await createChapterCompletions(chaptersWithPrompts); //returns newChapters (with completions)

      console.log('chaptersWithCompletions have been generated');

      let fullyPreparedChapters = extractTimesFromChapters(chaptersWithCompletions);
      console.log('sample fully prepared chapter =', fullyPreparedChapters[0])

      // //STEP 5 - GENERATE CLIPS
      console.log('generating clips...');
      console.log(path.resolve(localFileName))
      outputPaths = await generateAndResizeClips(fullyPreparedChapters, userId, path.resolve(localFileName)); //returns array of outputPaths

      console.log('clips have been generated');
      
      console.log(outputPaths);
      
      //TODO - send created clips back to front end

    } catch (error) {
    console.error('Error:', error);
    res.status(500).send({ error: 'An error occurred while processing the request.' });
    }
  });






/****************************
* Example post method *
****************************/

app.post('/clip-video', function(req, res) {
  // Add your code here
  res.json({success: 'post call succeed!', url: req.url, body: req.body})
});

app.post('/clip-video/*', function(req, res) {
  // Add your code here
  res.json({success: 'post call succeed!', url: req.url, body: req.body})
});

/****************************
* Example put method *
****************************/

app.put('/clip-video', function(req, res) {
  // Add your code here
  res.json({success: 'put call succeed!', url: req.url, body: req.body})
});

app.put('/clip-video/*', function(req, res) {
  // Add your code here
  res.json({success: 'put call succeed!', url: req.url, body: req.body})
});

/****************************
* Example delete method *
****************************/

app.delete('/clip-video', function(req, res) {
  // Add your code here
  res.json({success: 'delete call succeed!', url: req.url});
});

app.delete('/clip-video/*', function(req, res) {
  // Add your code here
  res.json({success: 'delete call succeed!', url: req.url});
});

app.listen(3000, function() {
    console.log("App started")
});

// Export the app object. When executing the application local this does nothing. However,
// to port it to AWS Lambda we will create a wrapper around that will load the app from
// this file
module.exports = app
