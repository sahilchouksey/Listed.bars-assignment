const path = require("path");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

const base64 = require("base64url");

// The default gmail that will be checked for new emails
// If you want to check for emails from a specific sender then
// change the DEFAULT_EMAIL to the email address of the sender
const DEFAULT_EMAIL = "anyone";
// The label name that will be created to mark the emails that have been replied to
const LABEL_NAME = "AUTOMATED_REPLY";

// gmail.readonly is when you only want to read the emails
// gmail.modify is when you want to read and modify the emails
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// The path to the credentials.json file
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

/**
 * Load or request or authorization to call APIs.
 */
async function authorize() {
  const client = await authenticate({
    // Scopes indicate which APIs you want to access.
    scopes: SCOPES,
    // Keyfile is the path to a .json file containing the authentication
    keyfilePath: CREDENTIALS_PATH,
  });

  return client;
}

// Returns gmail searching options
const getGmailSearchingOptions = (email) => {
  // setting the start date to 00:00:00 of the current day
  // this will make sure that we get all the emails from the start of the day
  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);

  // If the email is anyone then we will not search for emails from a specific sender
  const from = email == "anyone" ? "" : `from:${email} `;
  // Converting the date to seconds
  let after = Math.floor(startDate.getTime() / 1000); //  milliseconds to seconds
  after = `after:${after}`;
  return {
    userId: "me", // me represents the authenticated user

    q: `${from} ${after}`,
  };
};

// Generating a random interval between min and max
const randomInterval = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1) + min);
};

// Calling the checkForNewEmails function every 45-120 seconds
const checkForNewEmailsInterval = async (gmail, email) => {
  // Checking if the email is already being checked
  // Waiting for a random interval between 45 and 120 seconds
  // for testing purposes
  const interval = randomInterval(10, 15);

  // for production
  // const interval = randomInterval(45, 120);

  console.log(`Waiting for ${interval} seconds...`);
  // Checking for new emails after the interval
  // This will run forever
  setTimeout(() => {
    checkForNewEmails(gmail, email);
  }, interval * 1000);
};

/*
 * Get label
 */
async function getLabel(gmail) {
  // Getting the label
  const labelRes = await gmail.users.labels.list({
    userId: "me",
  });
  const labels = labelRes.data.labels;
  const label = labels.find((label) => label.name === LABEL_NAME);
  // Creating label if it doesn't exist
  if (!label) {
    await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: LABEL_NAME,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
  }
  return label;
}

/**
 * Check for new emails from a specific sender or anyone.
 */
async function checkForNewEmails(gmail, email) {
  console.log("Checking for ", email === "anyone" ? "incoming emails" : email);

  const gmailSearchOptions = getGmailSearchingOptions(email);

  // Searching for emails from a specific sender after a specific date
  const res = await gmail.users.threads.list(gmailSearchOptions);

  // Getting the threads from response(res)
  const threads = res.data.threads || [];
  if (!threads || threads.length === 0) {
    console.log("No threads found.");
    // Checking for new emails after an interval
    checkForNewEmailsInterval(gmail, email);
    return false;
  }

  // Getting the label
  const label = await getLabel(gmail);

  const newThreads = [];
  for (const thread of threads) {
    // Send replies to Threads that have no prior replies
    const replied = await sendReply(gmail, thread.id, label);
    // Marking the thread as replied
    if (replied) {
      newThreads.push(
        `${thread.id} - ${replied.email} - ${replied.receivedTime} auto replied`
      );
      console.log(
        `${thread.id} - ${replied.email} - ${replied.receivedTime} auto replied `
      );
    }
  }

  // Checking for new emails after an interval
  checkForNewEmailsInterval(gmail, email);

  // Returning the new messages
  return newThreads;
}

/**
 * Send a reply to an email.
 */
async function sendReply(gmail, threadId, label) {
  // Getting the thread
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
  });

  const messages = thread.data.messages || [];
  const firstMessage = messages[0];

  // Printing the firstMessage
  let FROM, TO, SUBJECT;
  firstMessage.payload.headers.forEach((header) => {
    if (header.name === "From") FROM = header.value;
    if (header.name === "To") TO = header.value;
    if (header.name === "Subject") SUBJECT = header.value;
  });

  const replies = thread.data.messages.slice(1); // Exclude the first message (original email sent by the user)

  if (replies.length === 0) {
    // Send a reply only if there are no replies
    const replyHeaders = {
      From: FROM,
      To: TO,
      Subject: SUBJECT,
    };

    const replyBody =
      "This is a automated reply. \n\nI am on vacation. I will reply to your email when I get back. \n\nThanks, \nSahil Chouksey";

    const rawContent =
      Object.keys(replyHeaders)
        .map((key) => `${key}: ${replyHeaders[key]}`)
        .join("\r\n") +
      "\r\n\r\n" +
      replyBody;

    const encodedRawContent = base64.encode(rawContent);

    // Sending the reply
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedRawContent,
        threadId: threadId,
      },
    });

    // Add a label to the message to indicate that it has been replied to
    await gmail.users.messages.modify({
      userId: "me",
      id: threadId,
      requestBody: {
        addLabelIds: [label.id],
      },
    });
  }

  // checking if the email is replied or not
  const labelIds = firstMessage.labelIds || [];
  const hasLabel = labelIds.includes(label.id);

  // Thread start time
  const receivedMessage = firstMessage.payload.headers.find(
    (header) => header.name.toLowerCase() == "received"
  );
  const receivedTime = receivedMessage.value.split(";")[1].trim();
  // Returning the email address and received time
  return replies.length === 0 || hasLabel
    ? { email: FROM, receivedTime }
    : false;
}

// Get logged in user's email
const getEmailAddress = async (gmail) => {
  // Get the user's profile
  const profile = await gmail.users.getProfile({
    userId: "me",
  });

  // Extract the email address from the profile
  const emailAddress = profile.data.emailAddress;

  return emailAddress;
};

// Creating a http server that will listen on port 8080
const main = async () => {
  try {
    // Getting the email from command line arguments
    // "Anyone" is a special keyword that will check for all the emails
    // By default it will check for the DEFAULT_EMAIL
    const email = process.argv[2] || DEFAULT_EMAIL;

    // Authorizing the client
    console.log("Authorizing the client...");

    // waiting for authorization to complete
    const client = await authorize();

    // Creating a new gmail instance
    const gmail = google.gmail({ version: "v1", auth: client });

    // Getting the email address and gmail instance
    const emailAddress = await getEmailAddress(gmail);

    // Printing the email address
    console.log(`Logged in as ${emailAddress}`);

    // Checking for new emails
    await checkForNewEmails(gmail, email);
  } catch (error) {
    console.error(error);
  }
};

main();
