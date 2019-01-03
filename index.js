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
  MODERATED: 1
  // USER_PROCESSED: 1,
  // MODERATOR_PROCESSED: 2,
  // MODERATOR_APPROVED: 3,
  // ACTIVE: 4
};

const MODERATED_KLIPP_STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  LIVE: 3
};

const SLICE_REQUEST_QUEUE = "slice request";
const MODERATION_QUEUE = "klipp moderation";

const hash = url => md5(url);

app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());
app.use(cors());

const port = 3000;

app.get("/", (req, res) =>
  res.send("<html><head></head><body>Hello World!</body></html>")
);

const getPresignedUrl = props => {
  return new Promise((resolve, reject) => {
    s3.getSignedUrl(
      "getObject",
      {
        Bucket: s3Bucket,
        Expires: 3600,
        Key: props.s3Key
      },
      (error, url) => {
        if (error) {
          reject(error);
        }
        resolve({
          url,
          ...props
        });
      }
    );
  });
};

app.get("/api/v1/admin/klipps/pending_moderation", (req, res) => {
  firestore
    .collection("klipps")
    .where("status", "==", 0)
    .get()
    .then(querySnapshot => {
      const data = [];
      querySnapshot.forEach(doc => {
        console.log(doc.id, " => ", doc.data());
        const {
          source_domain,
          s3_key,
          youtube_dl_info: {
            fulltitle,
            thumbnail,
            title,
            webpage_url,
            view_count,
            upload_date,
            quality,
            like_count,
            format,
            format_id,
            format_note
          }
        } = doc.data();

        data.push({
          source_domain,
          fulltitle,
          thumbnail,
          title,
          webpage_url,
          view_count,
          upload_date,
          quality,
          like_count,
          format,
          format_id,
          format_note,
          s3Key: s3_key
        });
      });

      Promise.all(data.map(item => getPresignedUrl(item))).then(responses => {
        res.json({
          klipps: responses.map(response => response)
        });
      });
    })
    .catch(e => {
      console.log("Error getting documents: ", error);
    });
});

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

      Promise.all(s3Keys.map(s3Key => getPresignedUrl({ s3Key }))).then(
        responses => {
          res.json({
            videos: responses.map(response => response)
          });
        }
      );
    });
});

app.post("/api/v1/admin/slice", (req, res) => {
  const { url, slice_start, slice_end } = req.body;

  firestore
    .collection("moderated_klipps")
    .doc(hash(url))
    .set({})
    .then(docRef => {
      const job = queue
        .create(MODERATION_QUEUE, {
          title: `admin: slice up ${url} starting ${slice_start} ending ${slice_end}`,
          docRefId: docRef.id,
          url,
          slice_start,
          slice_end
        })
        .save(function(err) {
          if (!err) {
            console.log(`Job #${job.id} added in ${MODERATION_QUEUE}`);
            res.json({ message: "Successfully added url", ackId: docRef.id });
          } else {
            res.status(500).json({
              message: "Something went wrong in adding to queue",
              error: err
            });
          }
        });
    })
    .catch(e => {
      res.status(500).json({ message: "Something went wrong in db", error: e });
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
      if (!err) console.log(`Job #${job.id} added in ${SLICE_REQUEST_QUEUE}`);
    });

  res.json("Hello World!");
});

const processQueueItem = (
  { url, startAt, duration },
  done,
  createOrUpdate,
  updateProps = null
) => {
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

            delete info.formats;
            delete info.http_headers;

            firestore
              .collection(
                createOrUpdate === "create" ? "klipps" : "moderated_klipps"
              )
              .doc(hash(url))
              .set({
                requested_web_url: url,
                source_domain: hostname,
                start_at: startAt,
                status:
                  createOrUpdate === "create"
                    ? KLIPP_STATUS.UPLOADED
                    : MODERATED_KLIPP_STATUS.APPROVED,
                youtube_dl_info: info,
                s3_key: s3Key
              })
              .then(docRef => {
                done();
              })
              .catch(e => {
                done(new Error(e));
              });
          }
        );
      });
  });
};

if (cluster.isMaster) {
  kue.app.listen(3001);
  for (let i = 0; i < clusterWorkerSize; i++) {
    cluster.fork();
  }
  app.listen(port, () => console.log(`Klipply ready on port ${port}!`));
} else {
  queue.process(MODERATION_QUEUE, (job, done) => {
    const { docRefId, url, slice_start, slice_end } = job.data;
    const startAt = `00:00:${Math.floor(slice_start)}`;
    const duration = `00:00:${Math.round(slice_end - slice_start)}`;

    processQueueItem({ url, startAt, duration }, done, "update", { docRefId });
  });

  queue.process(SLICE_REQUEST_QUEUE, (job, done) => {
    const { url, slice_at } = job.data;

    const userSelectedTime =
      slice_at.split(":").length === 2 ? `00:${slice_at}` : slice_at;

    const startAt = moment(userSelectedTime, "HH:mm:ss")
      .subtract(30, "seconds")
      .format("HH:mm:ss");

    const duration = "00:01:00";
    processQueueItem({ url, startAt, duration }, done, "create");
  });
}

queue.on("error", function(err) {
  console.log("kue error", err);
});
