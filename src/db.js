const Database=require("better-sqlite3"),fs=require("node:fs"),path=require("node:path");
const file=path.resolve(process.env.DB_PATH||"data/mppsc-iq.sqlite");fs.mkdirSync(path.dirname(file),{recursive:true});
const db=new Database(file);db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");
db.exec(`
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY,telegram_id TEXT UNIQUE,name TEXT,username TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tests(id INTEGER PRIMARY KEY,title TEXT NOT NULL,unit TEXT DEFAULT '',duration_minutes INTEGER DEFAULT 60,published INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY,test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,question_hi TEXT NOT NULL,question_en TEXT DEFAULT '',options_json TEXT NOT NULL,correct_index INTEGER NOT NULL,explanation TEXT DEFAULT '',sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,student_id INTEGER REFERENCES students(id),test_id INTEGER REFERENCES tests(id),score INTEGER,total INTEGER,answers_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS wrong_questions(id INTEGER PRIMARY KEY,student_id INTEGER REFERENCES students(id),test_id INTEGER REFERENCES tests(id),question_id INTEGER REFERENCES questions(id),last_answer INTEGER,UNIQUE(student_id,question_id));
CREATE TABLE IF NOT EXISTS resources(id INTEGER PRIMARY KEY,title TEXT,unit TEXT DEFAULT '',file_path TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);module.exports=db;
