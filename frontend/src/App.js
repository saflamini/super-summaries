import React, { useState, useEffect } from 'react';
import './App.css';
import Amplify, { API } from 'aws-amplify';
import { withAuthenticator, Button, Heading } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

function App({ signOut, user}) {
  const [file, setFile] = useState(null);
  const [clips, setClips] = useState([]);

  useEffect(() => {
    handleClipVideo();
  }, []);

  const [message, setMessage] = useState('');

  const handleClipVideo = async () => {
    console.log('submitting')
    API.get("clipvideo123", "/clip-video", {})
    .then(response => {
      console.log(response);
      setMessage(response.success)
    })
    .catch(error => {
      console.log(error.response);
    });
  }

  const handleSubmit = async (event) => {
    console.log('submitting')
    try {
    
      event.preventDefault();

      console.log(file);
      
      if (!file) return;
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', user.username);
      
      const response = await fetch('http://localhost:5001/upload', {
        method: 'POST',
        body: formData,
      });

      let uploadResponse;

      // await API.post("clipvideo123", "/upload", {
      //   body: formData
      // }).then(response => {
      //   uploadResponse = response;
      //   console.log(response);
      // })
      // .catch(error => {
      //   console.log(error.response);
      // });

      // const result = await uploadResponse.json();
      // console.log(result)
      // setClips(result.clips);
  } catch (error) {
      console.log("error occured");
    
      console.log(error);
  }
  };

  const handleFileChange = (event) => {
    setFile(event.target.files[0]);
  };

  // const handlePromptChange = (event) => {
  //   setPrompt(event.target.value);
  // };

  return (
    <div className="App">
      <h1>Video Clip Generator</h1>
      <h2>{message}</h2>
      <Heading level={1}>Hello {user.username}</Heading>
      <Button onClick={signOut}>Sign out</Button>
      <form onSubmit={handleSubmit}>
        <label htmlFor="file">Select a file:</label>
        <p>
        <input type="file" id="file" accept=".mp4" onChange={handleFileChange} />
        </p>
        <button type="submit">Generate Clips</button>
      </form>
      <h2>Generated Clips:</h2>
      <ul>
        {clips.map((clip, index) => (
          <li key={index}>
            <a href={clip} download={`clip_${index}.mp4`}>
              Clip {index + 1}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default withAuthenticator(App);
