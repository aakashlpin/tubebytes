const fs = require("fs");
const urlParser = require("url");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const youtubedl = require("youtube-dl");
const ffmpeg = require("fluent-ffmpeg");
const AWS = require("aws-sdk");
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
};

const MODERATED_KLIPP_STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  LIVE: 3
};

const SLICE_REQUEST_QUEUE = "slice request";
const MODERATION_QUEUE = "klipp moderation";

const getDocName = ({ extractor_key, id, start_at }) =>
  `${extractor_key}__${id}__${start_at}`;
const getVideoFileName = name => `${name}.mp4`;

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
        Key: props.s3_key
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
        data.push(doc.data());
      });

      Promise.all(data.map(item => getPresignedUrl(item))).then(responses => {
        res.json({
          klipps: responses.map(response => response)
        });
      });
    })
    .catch(e => {
      console.log("Error getting documents: ", e);
    });
});

app.get("/api/v1/slices", (req, res) => {
  firestore
    .collection("moderated_klipps")
    .where("status", "==", MODERATED_KLIPP_STATUS.APPROVED)
    .get()
    .then(querySnapshot => {
      const klipps = [];
      querySnapshot.forEach(doc => {
        const data = doc.data();
        const {
          info: { thumbnail, title, categories, tags },
          s3_key
        } = data;

        klipps.push({
          s3_key,
          thumbnail,
          title,
          categories,
          tags
        });
      });

      Promise.all(klipps.map(getPresignedUrl)).then(responses => {
        res.json({
          videos: responses.map(response => response)
        });
      });
    });
});

app.post("/api/v1/admin/slice", (req, res) => {
  const { url, slice_start, slice_end, s3_key } = req.body;

  const klippDocName = s3_key.replace(".mp4", "");

  firestore
    .collection("klipps")
    .doc(klippDocName)
    .get()
    .then(doc => {
      if (doc.exists) {
        const klippData = doc.data();
        const {
          start_at,
          info: { extractor_key, id }
        } = klippData;
        const moderated_start_at = moment(start_at, "HH:mm:ss")
          .add(slice_start, "seconds")
          .format("HH:mm:ss");
        const moderated_end_at = moment(start_at, "HH:mm:ss")
          .add(slice_end, "seconds")
          .format("HH:mm:ss");
        const moderatedDocName = getDocName({
          extractor_key,
          id,
          start_at: moderated_start_at
        });

        const secondsInHHmmss = seconds =>
          moment.utc(seconds * 1000).format("HH:mm:ss");

        firestore
          .collection("moderated_klipps")
          .doc(moderatedDocName)
          .set({})
          .then(docRef => {
            const job = queue
              .create(MODERATION_QUEUE, {
                title: `admin: slice up ${url} starting ${slice_start} ending ${slice_end}`,
                klippDocName,
                moderatedDocName,
                url,
                start_at: moderated_start_at,
                duration: secondsInHHmmss(
                  moment(moderated_end_at, "HH:mm:ss").diff(
                    moment(moderated_start_at, "HH:mm:ss"),
                    "seconds"
                  )
                )
              })
              .save(function(err) {
                if (!err) {
                  console.log(`Job #${job.id} added in ${MODERATION_QUEUE}`);
                  res.json({
                    message: "Successfully added url",
                    ackId: docRef.id
                  });
                } else {
                  res.status(500).json({
                    message: "Something went wrong in adding to queue",
                    error: err
                  });
                }
              });
          })
          .catch(e => {
            res
              .status(500)
              .json({ message: "Something went wrong in db", error: e });
          });
      } else {
      }
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

const getVideoInfo = url =>
  new Promise((resolve, reject) => {
    youtubedl.getInfo(url, ["--format=best"], function(err, info) {
      if (err) reject(err);
      resolve(info);
    });
  });

const klipMediaToLocalDevice = props =>
  new Promise((resolve, reject) => {
    console.log("klipMediaToLocalDevice started");
    ffmpeg(props.info.url)
      .inputOptions([`-ss ${props.startAt}`, `-t ${props.duration}`])
      .save(props.localMediaPath)
      .on("start", commandLine => {
        console.log("Spawned ffmpeg with command: " + commandLine);
      })
      .on("error", reject)
      .on("end", () => {
        console.log("klipMediaToLocalDevice completed");
        resolve(props);
      });
  });

const uploadToRemoteStorage = props =>
  new Promise((resolve, reject) => {
    console.log("uploadToRemoteStorage started");
    s3.putObject(
      {
        Body: fs.createReadStream(props.localMediaPath),
        Bucket: s3Bucket,
        Key: props.klippVideoFilename,
        ContentDisposition: `inline; filename="${props.klippVideoFilename.replace(
          '"',
          "'"
        )}"`,
        ContentType: "video/mp4"
      },
      err => {
        if (err) reject(err);
        resolve(props);
        console.log("uploadToRemoteStorage completed");
      }
    );
  });

const cleanup = ({ info, ...props }) =>
  new Promise(resolve => {
    console.log("cleanup started");
    fs.unlinkSync(props.localMediaPath);
    delete info.formats;
    delete info.http_headers;

    resolve({
      info,
      ...props
    });
    console.log("cleanup completed");
  });

const addKlippDbRecord = props =>
  new Promise((resolve, reject) => {
    console.log("addKlippDbRecord started");
    firestore
      .collection("klipps")
      .doc(props.klippDocName)
      .set({
        status: KLIPP_STATUS.UPLOADED,
        s3_key: props.klippVideoFilename,
        source_domain: props.hostname,
        start_at: props.startAt,
        info: props.info
      })
      .then(() => {
        resolve(props);
        console.log("addKlippDbRecord completed");
      })
      .catch(e => {
        reject(e);
        console.log("addKlippDbRecord failed");
      });
  });

const updateDbRecords = props =>
  new Promise((resolve, reject) => {
    console.log("updateDbRecords started");
    firestore
      .collection("moderated_klipps")
      .doc(props.klippDocName)
      .set({
        s3_key: props.klippVideoFilename,
        source_domain: props.hostname,
        start_at: props.startAt,
        status: MODERATED_KLIPP_STATUS.APPROVED,
        info: props.info
      })
      .then(() => {
        resolve(props);
        console.log("updateDbRecords completed");
      })
      .catch(e => {
        reject(e);
        console.log("updateDbRecords failed");
      });
  });

if (cluster.isMaster) {
  kue.app.listen(3001);
  for (let i = 0; i < clusterWorkerSize; i++) {
    cluster.fork();
  }
  app.listen(port, () => console.log(`Klipply ready on port ${port}!`));
} else {
  queue.process(MODERATION_QUEUE, (job, done) => {
    const { url, start_at, duration } = job.data;

    const { hostname } = urlParser.parse(url);

    getVideoInfo(url)
      .then(
        info =>
          new Promise(resolve => {
            const klippDocName = getDocName({
              extractor_key: info.extractor_key,
              id: info.id,
              start_at
            }); // Youtube_qU5FWU0SH0o_00:00:28
            const klippVideoFilename = getVideoFileName(klippDocName); // Youtube_qU5FWU0SH0o_00:00:28.mp4

            console.log(`\n---Starting up ${klippVideoFilename}---`);

            const localMediaPath = path.resolve(
              __dirname,
              "media",
              klippVideoFilename
            );

            resolve({
              klippDocName,
              klippVideoFilename,
              localMediaPath,
              url,
              startAt: start_at,
              duration,
              hostname,
              info
            });
          })
      )
      .then(klipMediaToLocalDevice)
      .then(uploadToRemoteStorage)
      .then(cleanup)
      .then(updateDbRecords)
      .then(() => {
        firestore
          .collection("klipps")
          .doc(job.data.klippDocName)
          .set(
            {
              status: KLIPP_STATUS.MODERATED
            },
            { merge: true }
          )
          .then(() => {
            done();
          });
      })
      .catch(e => {
        done(new Error(e));
      });
  });

  queue.process(SLICE_REQUEST_QUEUE, (job, done) => {
    const { url, slice_at } = job.data;

    const userSelectedTime =
      slice_at.split(":").length === 2 ? `00:${slice_at}` : slice_at;

    const startAt = moment(userSelectedTime, "HH:mm:ss")
      .subtract(30, "seconds")
      .format("HH:mm:ss");

    const duration = "00:01:00";

    const { hostname } = urlParser.parse(url);

    getVideoInfo(url)
      .then(
        info =>
          new Promise(resolve => {
            const klippDocName = getDocName({
              extractor_key: info.extractor_key,
              id: info.id,
              start_at: startAt
            }); // Youtube_qU5FWU0SH0o_00:00:28
            const klippVideoFilename = getVideoFileName(klippDocName); // Youtube_qU5FWU0SH0o_00:00:28.mp4

            console.log(`\n---Starting up ${klippVideoFilename}---`);

            const localMediaPath = path.resolve(
              __dirname,
              "media",
              klippVideoFilename
            );

            resolve({
              klippDocName,
              klippVideoFilename,
              localMediaPath,
              url,
              startAt,
              duration,
              hostname,
              info
            });
          })
      )
      .then(klipMediaToLocalDevice)
      .then(uploadToRemoteStorage)
      .then(cleanup)
      .then(addKlippDbRecord)
      .then(() => {
        done();
      })
      .catch(e => {
        done(new Error(e));
      });
  });
}

queue.on("error", function(err) {
  console.log("kue error", err);
});
