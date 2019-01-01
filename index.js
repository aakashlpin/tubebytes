const fs = require("fs");
const md5 = require("md5");
const urlParser = require("url");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const youtubedl = require("youtube-dl");
const ffmpeg = require("fluent-ffmpeg");
const AWS = require("aws-sdk");
const readline = require("readline");
const cors = require("cors");
const moment = require("moment");
const kue = require("kue");
const cluster = require("cluster");
const Firestore = require("@google-cloud/firestore");

const queue = kue.createQueue();
const clusterWorkerSize = require("os").cpus().length;
const s3 = new AWS.S3();
const s3Bucket = "onehandapp-downloader";
const app = express();

const firestore = new Firestore({
  projectId: "klipply",
  keyFilename: "./klipply-service-account.json",
  timestampsInSnapshots: true
});

const KLIPP_STATUS = {
  UPLOADED: 0,
  USER_PROCESSED: 1,
  MODERATOR_PROCESSED: 2,
  MODERATOR_APPROVED: 3,
  ACTIVE: 4
};

const SLICE_REQUEST_QUEUE = "slice request";

const hash = url => md5(url);

app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());
app.use(cors());

const port = 3000;

app.get("/", (req, res) =>
  res.send("<html><head></head><body>Hello World!</body></html>")
);

const getPresignedUrl = s3Key => {
  return new Promise((resolve, reject) => {
    s3.getSignedUrl(
      "getObject",
      {
        Bucket: s3Bucket,
        Expires: 3600,
        Key: s3Key
      },
      (error, url) => {
        if (error) {
          reject(error);
        }
        resolve(url);
      }
    );
  });
};

app.get("/api/v1/slices", (req, res) => {
  firestore
    .collection("klipps")
    .get()
    .then(querySnapshot => {
      const s3Keys = [];
      querySnapshot.forEach(doc => {
        const data = doc.data();
        s3Keys.push(data.s3_key);
      });

      Promise.all(s3Keys.map(getPresignedUrl)).then(responses => {
        res.json({
          videos: responses.map(response => response)
        });
      });
    });
});

app.post("/api/v1/slice", (req, res) => {
  const { url, slice_at, video_length } = req.body;
  /**
   * <t-xseconds of slice_at time, t+yseconds>
   */

  const job = queue
    .create(SLICE_REQUEST_QUEUE, {
      title: `slice up ${url} starting ${slice_at} (duration: ${video_length})`,
      url,
      slice_at,
      video_length
    })
    .save(function(err) {
      if (!err) console.log(job.id);
    });

  res.json("Hello World!");
});

if (cluster.isMaster) {
  kue.app.listen(3001);
  for (let i = 0; i < clusterWorkerSize; i++) {
    cluster.fork();
  }
  app.listen(port, () => console.log(`Klipply ready on port ${port}!`));
} else {
  queue.process(SLICE_REQUEST_QUEUE, (job, done) => {
    const { url, slice_at } = job.data;

    const userSelectedTime =
      slice_at.split(":").length === 2 ? `00:${slice_at}` : slice_at;

    const startAt = moment(userSelectedTime, "HH:mm:ss")
      .subtract(30, "seconds")
      .format("HH:mm:ss");

    const duration = "00:01:00";
    const { hostname } = urlParser.parse(url);

    youtubedl.getInfo(url, ["--format=best"], function(err, info) {
      if (err) throw err;

      const sliceVideoFilename = `${info.title.replace(
        /[^A-Z0-9]+/gi,
        "_"
      )}_${startAt}_${duration}.mp4`;

      console.log(`\n---Starting up ${sliceVideoFilename}---`);

      const slicedVideoPath = path.resolve(
        __dirname,
        "media",
        sliceVideoFilename
      );

      ffmpeg(info.url)
        .inputOptions([`-ss ${startAt}`, `-t ${duration}`])
        .save(slicedVideoPath)
        .on("error", console.error)
        .on("progress", progress => {
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(progress.timemark);
        })
        .on("end", () => {
          console.log("\nSending it to the clouds! Please wait... ☁️");

          const s3Key = `${hostname}/${sliceVideoFilename}`;

          s3.putObject(
            {
              Body: fs.createReadStream(slicedVideoPath),
              Bucket: s3Bucket,
              Key: s3Key,
              ContentDisposition: `inline; filename="${sliceVideoFilename.replace(
                '"',
                "'"
              )}"`,
              ContentType: "video/mp4"
            },
            error => {
              if (error) {
                revoke(error);
                done(new Error(error));
                console.log("\nErrored! ❌");
                return;
              }
              console.log("\nSent! 🎉");
              fs.unlinkSync(slicedVideoPath);
              console.log("\nCleaned up! 🗑");

              firestore
                .collection("klipps")
                .doc(hash(job.data.url))
                .set({
                  source_domain: hostname,
                  start_at: startAt,
                  status: KLIPP_STATUS.UPLOADED,
                  youtube_dl_info: info,
                  s3_key: s3Key
                })
                .then(docRef => {
                  // res.json({ message: 'Successfully added url', ackId: docRef.id });
                  done();
                })
                .catch(e => {
                  done(new Error(e));
                  // res.status(500).json({ message: 'Something went wrong', error: e });
                });
            }
          );
        });
    });
  });
}

queue.on("error", function(err) {
  console.log("kue error", err);
});
