const express = require('express');
const http = require('http');
const dialogflow = require('dialogflow');
const uuid = require('uuid');
const app = express();
const bodyParser = require('body-parser');
const request = require('request');
const config = require('./config/config');
const {User} = require('./models/user-model');
const {mongoose} = require('./db/mongoose');
var fs = require('fs')
var logger = fs.createWriteStream('log.txt', {
  flags: 'a'
})
app.use(bodyParser.json());
app.use(bodyParser.json({
  verify: verifyRequestSignature
}));

app.use(bodyParser.urlencoded({
  extended: false
}));

app.use(bodyParser.json());


const credentials = {
  client_email: config.GOOGLE_CLIENT_EMAIL,
  private_key: config.GOOGLE_PRIVATE_KEY,
};

const sessionClient = new dialogflow.SessionsClient(
  {
      projectId: config.GOOGLE_PROJECT_ID,
      credentials
  }
);

const sessionIds = new Map();

app.get('/', function (req, res) {
  res.send('Hello world, I am a chat bot')
})

app.get('/webhook/', function (req, res) {
  console.log("request");
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.FB_VERIFY_TOKEN) {
      res.status(200).send(req.query['hub.challenge']);
  } else {
      console.error("Failed validation. Make sure the validation tokens match.");
      res.sendStatus(403);
  }
})


app.post('/webhook/', function (req, res) {
  var data = req.body;
  if (data.object == 'page') {
      data.entry.forEach(function (pageEntry) {
          var pageID = pageEntry.id;
          var timeOfEvent = pageEntry.time;

          pageEntry.messaging.forEach(function (messagingEvent) {
            if (messagingEvent.message) {
                  receivedMessage(messagingEvent);
              } else {
                  console.log("unknown messagingEvent: ", messagingEvent);
              }
          });
      });
      res.sendStatus(200);
  }
});





function receivedMessage(event) {
    console.log("inside received messgae");
  console.log(event);
  
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  if (!sessionIds.has(senderID)) {
      sessionIds.set(senderID, uuid.v1());
  }
  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  console.log(JSON.stringify(message,undefined,5));
  
  if (isEcho) {
      return;
  } else if (quickReply) {
      handleQuickReply(senderID, quickReply, messageId);
      return;
  }


  if (messageText) {
      sendToDialogFlow(senderID, messageText);
  } else if (messageAttachments) {
      handleMessageAttachments(messageAttachments, senderID);
  }
}


function handleMessageAttachments(messageAttachments, senderID){
  //for now just reply
  sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
  var quickReplyPayload = quickReply.payload;
  console.log("Quick reply for message %s with payload %s", messageId, quickReplyPayload);
  //send payload to api.ai
  sendToDialogFlow(senderID, quickReplyPayload);
}


function handleUserData(sender, action, messages, contexts, parameters) {

    // console.log('sender',sender);
    // console.log('message',messages);
    // console.log('context',contexts);
    // console.log(JSON.stringify(contexts,undefined,5));
    // console.log('parameters',parameters.fields);
    switch (action) {
        case 'user-details':
            if(checkUserData(parameters.fields)){
                addDataInDatabase(parameters.fields );
            }
      default:
          handleMessages(messages, sender);
  }
}


checkUserData = (user) =>  (user['user-name']['stringValue'] && user['DOB']['stringValue']&& user['email']['stringValue']&& user['password']['stringValue'])


function addDataInDatabase(user){
    let userData = new User({
        userName : user['user-name']['stringValue'],
        password:user['password']['stringValue'],
        DOB:user['DOB']['stringValue'],
        email:user['email']['stringValue'],
    });
    logger.write(JSON.stringify(userData));
    userData.save().then((savedUser)=>{
        console.log("user saved sucessfully");
    }).catch((e)=>{
        console.error(e);   
    })
}




function handleMessage(message, sender) {
  switch (message.message) {
      case "text": //text
          message.text.text.forEach((text) => {
              if (text !== '') {
                  sendTextMessage(sender, text);
              }
          });
          break;
      case "quickReplies": //quick replies
          let replies = [];
          message.quickReplies.quickReplies.forEach((text) => {
              let reply =
                  {
                      "content_type": "text",
                      "title": text,
                      "payload": text
                  }
              replies.push(reply);
          });
          sendQuickReply(sender, message.quickReplies.title, replies);
          break;
  }
}


function handleCardMessages(messages, sender) {

  let elements = [];
  for (var m = 0; m < messages.length; m++) {
      let message = messages[m];
      let buttons = [];
      for (var b = 0; b < message.card.buttons.length; b++) {
          let isLink = (message.card.buttons[b].postback.substring(0, 4) === 'http');
          let button;
          if (isLink) {
              button = {
                  "type": "web_url",
                  "title": message.card.buttons[b].text,
                  "url": message.card.buttons[b].postback
              }
          } else {
              button = {
                  "type": "postback",
                  "title": message.card.buttons[b].text,
                  "payload": message.card.buttons[b].postback
              }
          }
          buttons.push(button);
      }


      let element = {
          "title": message.card.title,
          "image_url":message.card.imageUri,
          "subtitle": message.card.subtitle,
          "buttons": buttons
      };
      elements.push(element);
  }
  sendGenericMessage(sender, elements);
}


function handleMessages(messages, sender) {
  let timeoutInterval = 1100;
  let previousType ;
  let cardTypes = [];
  let timeout = 0;
  for (var i = 0; i < messages.length; i++) {

      if ( previousType == "card" && (messages[i].message != "card" || i == messages.length - 1)) {
          timeout = (i - 1) * timeoutInterval;
          setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
          cardTypes = [];
          timeout = i * timeoutInterval;
          setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
      } else if ( messages[i].message == "card" && i == messages.length - 1) {
          cardTypes.push(messages[i]);
          timeout = (i - 1) * timeoutInterval;
          setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
          cardTypes = [];
      } else if ( messages[i].message == "card") {
          cardTypes.push(messages[i]);
      } else  {
          timeout = i * timeoutInterval;
          setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
      }
      previousType = messages[i].message;
  }
}

function handleDialogFlowResponse(sender, response) {
  let responseText = response.fulfillmentMessages.fulfillmentText;

  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  sendTypingOff(sender);

  if (isDefined(action)) {
      handleUserData(sender, action, messages, contexts, parameters);
  } else if (isDefined(messages)) {
      handleMessages(messages, sender);
  } else if (responseText == '' && !isDefined(action)) {
      //dialogflow could not evaluate input.
      sendTextMessage(sender, "I'm not sure what you want. Can you be more specific?");
  } else if (isDefined(responseText)) {
      sendTextMessage(sender, responseText);
  }
}

async function sendToDialogFlow(sender, textString, params) {

  sendTypingOn(sender);

  try {
      const sessionPath = sessionClient.sessionPath(
          config.GOOGLE_PROJECT_ID,
          sessionIds.get(sender)
      );

      const request = {
          session: sessionPath,
          queryInput: {
              text: {
                  text: textString,
                  languageCode: config.DF_LANGUAGE_CODE,
              },
          },
          queryParams: {
              payload: {
                  data: params
              }
          }
      };
      const responses = await sessionClient.detectIntent(request);

      const result = responses[0].queryResult;
      handleDialogFlowResponse(sender, result);
  } catch (e) {
      console.log('error');
      console.log(e);
  }

}




function sendTextMessage(recipientId, text) {
  var messageData = {
      recipient: {
          id: recipientId
      },
      message: {
          text: text
      }
  }
  callSendAPI(messageData);
}


function sendGenericMessage(recipientId, elements) {
  var messageData = {
      recipient: {
          id: recipientId
      },
      message: {
          attachment: {
              type: "template",
              payload: {
                  template_type: "generic",
                  elements: elements
              }
          }
      }
  };

  callSendAPI(messageData);
}


function sendQuickReply(recipientId, text, replies, metadata) {
  var messageData = {
      recipient: {
          id: recipientId
      },
      message: {
          text: text,
          metadata: isDefined(metadata)?metadata:'',
          quick_replies: replies
      }
  };

  callSendAPI(messageData);
}


function sendReadReceipt(recipientId) {

  var messageData = {
      recipient: {
          id: recipientId
      },
      sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}


function sendTypingOn(recipientId) {


  var messageData = {
      recipient: {
          id: recipientId
      },
      sender_action: "typing_on"
  };

  callSendAPI(messageData);
}


function sendTypingOff(recipientId) {


  var messageData = {
      recipient: {
          id: recipientId
      },
      sender_action: "typing_off"
  };

  callSendAPI(messageData);
}



function callSendAPI(messageData) {
  request({
      uri: 'https://graph.facebook.com/v3.2/me/messages',
      qs: {
          access_token: config.FB_PAGE_TOKEN
      },
      method: 'POST',
      json: messageData

  }, function (error, response, body) {
      if (!error && response.statusCode == 200) {
          var recipientId = body.recipient_id;
          var messageId = body.message_id;

          if (messageId) {
              console.log("Successfully sent message with id %s to recipient %s",
                  messageId, recipientId);
          } else {
                console.log("Successfully called Send API for recipient %s",
                recipientId);
          }
      } else {
          console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
      }
  });
}



function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  var payload = event.postback.payload;

  switch (payload) {
      default:
          //unindentified payload
          sendTextMessage(senderID, "I'm not sure what you want. Can you be more specific?");
          break;

  }
  console.log("Received postback for user %d and page %d with payload '%s' " +
      "at %d", senderID, recipientID, payload, timeOfPostback);

}

function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
      throw new Error('Couldn\'t validate the signature.');
  } else {
      var elements = signature.split('=');
      var method = elements[0];
      var signatureHash = elements[1];

      var expectedHash = crypto.createHmac('sha1', config.FB_APP_SECRET)
          .update(buf)
          .digest('hex');

      if (signatureHash != expectedHash) {
          throw new Error("Couldn't validate the request signature.");
      }
  }
}

function isDefined(obj) {
  if (typeof obj == 'undefined') return false;
  if (!obj) return false;
  return obj != null;
}


http.createServer(app).listen(3000 , ()=>{
    console.log('Started up HTTP at port ', 3000);
});