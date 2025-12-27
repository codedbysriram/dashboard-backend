require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("./db");

const app = express();

/* ================= BASIC MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());

/* ================= UPLOADS ================= */
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR));

/* ================= MULTER ================= */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const safe = (req.body.name || "student")
      .toLowerCase()
      .replace(/\s+/g, "_");
    cb(null, `${safe}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });


/* ================= TEST ================= */
app.get("/", (_, res) => {
  res.json({ status: "Backend running successfully" });
});

/* ==================================================
   SUBJECT LIST (FOR DROPDOWN)
================================================== */
app.get("/api/subjects", (req, res) => {
  const { year } = req.query;

  let sql = `
    SELECT DISTINCT subject_title
    FROM student_results
    WHERE subject_title IS NOT NULL
  `;
  const params = [];

  // ✅ FIX (defensive check)
  if (year && year !== "") {
    sql += " AND year=?";
    params.push(year);
  }

  sql += " ORDER BY subject_title";

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("SUBJECT LIST ERROR:", err);
      return res.status(500).json([]);
    }
    res.json(rows || []);
  });
});


/* ==================================================
   DASHBOARD RESULTS (MAIN + SUBJECT VIEW)
================================================== */
app.get("/api/results", (req, res) => {
  const { year, semester, subject } = req.query;
  const params = [];

  /* ===== SUBJECT VIEW (POSITION + MARKS) ===== */
if (subject && subject !== "") {
  let sql = `
    SELECT
      sr.regno,
      sr.name,
      sr.year,
      MAX(COALESCE(sr.photo,'')) AS photo,
      sr.total AS marks,
      @rank := @rank + 1 AS position,
      CASE
        WHEN sr.total >= 90 THEN 10
        WHEN sr.total >= 80 THEN 9
        WHEN sr.total >= 70 THEN 8
        WHEN sr.total >= 60 THEN 7
        WHEN sr.total >= 50 THEN 6
        ELSE 0
      END AS gpa
    FROM student_results sr
    JOIN (SELECT @rank := 0) r
    WHERE sr.subject_title = ?
  `;
  params.push(subject);

  if (year && year !== "") {
    sql += " AND sr.year=?";
    params.push(year);
  }

  if (semester && semester !== "") {
    sql += " AND sr.semester=?";
    params.push(semester);
  }

  sql += `
    GROUP BY sr.regno, sr.name, sr.year, sr.total
    ORDER BY sr.total DESC
  `;

  // ✅ FIX: no "return" here
  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("SUBJECT RESULT ERROR:", err);
      return res.status(500).json([]);
    }
    res.json(rows || []);
  });

  return; // stop main dashboard execution
}

  /* ===== MAIN DASHBOARD (ARREARS + CGPA) ===== */
  let sql = `
    SELECT
      sr.regno,
      sr.name,
      sr.year,
      MAX(COALESCE(sr.photo,'')) AS photo,
      COUNT(CASE WHEN sr.result='FAIL' THEN 1 END) AS arrears,
      ROUND(AVG(
        CASE
          WHEN sr.total >= 90 THEN 10
          WHEN sr.total >= 80 THEN 9
          WHEN sr.total >= 70 THEN 8
          WHEN sr.total >= 60 THEN 7
          WHEN sr.total >= 50 THEN 6
          ELSE 0
        END
      ), 2) AS cgpa
    FROM student_results sr
    WHERE sr.subject_code IS NOT NULL
  `;

  // ✅ FIX
  if (year && year !== "") {
    sql += " AND sr.year=?";
    params.push(year);
  }

  // ✅ FIX
  if (semester && semester !== "") {
    sql += " AND sr.semester=?";
    params.push(semester);
  }

  sql += `
    GROUP BY sr.regno, sr.name, sr.year
    ORDER BY sr.regno
  `;

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("DASHBOARD ERROR:", err);
      return res.status(500).json([]);
    }
    res.json(rows || []);
  });
});

/* ==================================================
   SUBJECT LIST PER STUDENT (ADMIN)
================================================== */
app.get("/api/results/:regno", (req, res) => {
  db.query(
    `
    SELECT *
    FROM student_results
    WHERE regno=? AND subject_code IS NOT NULL
    ORDER BY semester, subject_code
    `,
    [req.params.regno],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    }
  );
});

/* ==================================================
   ADD SUBJECT (PHOTO AUTO-COPIED)
================================================== */
app.post("/api/results", (req, res) => {
  const {
    regno, name, department, year,
    semester, subject_code, subject_title, ia, ea
  } = req.body;

  const total = Number(ia || 0) + Number(ea || 0);
  const result = total >= 50 ? "PASS" : "FAIL";

  db.query(
    `
    INSERT INTO student_results
    (regno, name, department, year, semester,
     subject_code, subject_title, ia, ea, total, result, photo)
    SELECT
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, MAX(photo)
    FROM student_results
    WHERE regno=?
    `,
    [
      regno, name, department, year,
      semester, subject_code, subject_title,
      ia, ea, total, result,
      regno
    ],
    err => {
      if (err) return res.status(500).json({ error: err.sqlMessage });
      res.json({ message: "Subject added successfully" });
    }
  );
});

/* ==================================================
   UPDATE MARKS (IA + EA → TOTAL)
================================================== */
app.put("/api/results/:id", (req, res) => {
  const { ia, ea } = req.body;

  const total = Number(ia || 0) + Number(ea || 0);
  const result = total >= 50 ? "PASS" : "FAIL";

  db.query(
    `
    UPDATE student_results
    SET ia=?, ea=?, total=?, result=?
    WHERE id=?
    `,
    [ia, ea, total, result, req.params.id],
    err => {
      if (err) {
        console.error("UPDATE MARKS ERROR:", err);
        return res.status(500).json({ error: "Update failed" });
      }
      res.json({ message: "Marks updated successfully" });
    }
  );
});

/* ==================================================
   DELETE SUBJECT
================================================== */
app.delete("/api/results/:id", (req, res) => {
  db.query(
    "DELETE FROM student_results WHERE id=?",
    [req.params.id],
    err => {
      if (err) return res.status(500).json({ error: "Delete failed" });
      res.json({ message: "Subject deleted" });
    }
  );
});

//* ================= DELETE STUDENT + ALL SUBJECTS ================= */
app.delete("/api/students/:id", (req, res) => {
  const id = req.params.id;

  // 1️⃣ Get regno from the selected student row
  db.query(
    "SELECT regno FROM student_results WHERE id = ?",
    [id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      if (rows.length === 0) {
        return res.status(404).json({ error: "Student not found" });
      }

      const regno = rows[0].regno;

      // 2️⃣ Delete ALL rows (student + subjects) for that regno
      db.query(
        "DELETE FROM student_results WHERE regno = ?",
        [regno],
        err2 => {
          if (err2) {
            console.error(err2);
            return res.status(500).json({ error: "Delete failed" });
          }

          res.json({
            message: "Student and all subjects deleted successfully"
          });
        }
      );
    }
  );
});

/* ==================================================
   STUDENT LIST (ADMIN)
================================================== */
app.get("/api/students", (_, res) => {
  db.query(
    `
    SELECT
      MIN(id) AS id,
      regno,
      name,
      year,
      department,
      MAX(COALESCE(photo,'')) AS photo
    FROM student_results
    GROUP BY regno, name, year, department
    ORDER BY regno
    `,
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    }
  );
});

/* ==================================================
   ADD STUDENT
================================================== */
app.post("/api/students", upload.single("photo"), (req, res) => {
  const { regno, name, year, department } = req.body;
  const photo = req.file ? req.file.filename : "";

  db.query(
    `
    INSERT INTO student_results
    (regno, name, department, year, photo)
    VALUES (?, ?, ?, ?, ?)
    `,
    [regno, name, department, year, photo],
    err => {
      if (err) return res.status(500).json({ error: err.sqlMessage });
      res.json({ message: "Student added successfully" });
    }
  );
});

/* ==================================================
   UPDATE STUDENT (REGNO-WISE PHOTO UPDATE)
================================================== */
app.put("/api/students/:id", upload.single("photo"), (req, res) => {
  const { regno, name, department, year } = req.body;
  const newPhoto = req.file ? req.file.filename : null;

  db.query(
    "SELECT regno FROM student_results WHERE id=?",
    [req.params.id],
    (err, rows) => {
      if (err || rows.length === 0)
        return res.status(404).json({ error: "Student not found" });

      const oldRegno = rows[0].regno;

      let sql = `
        UPDATE student_results
        SET regno=?, name=?, department=?, year=?
      `;
      const params = [regno, name, department, year];

      if (newPhoto) {
        sql += ", photo=?";
        params.push(newPhoto);
      }

      sql += " WHERE regno=?";
      params.push(oldRegno);

      db.query(sql, params, err2 => {
        if (err2) return res.status(500).json({ error: "Update failed" });
        res.json({ message: "Student profile updated successfully" });
      });
    }
  );
});

/* ================= START ================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
