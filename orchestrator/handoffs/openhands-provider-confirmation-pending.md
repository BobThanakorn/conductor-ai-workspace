# OpenHands provider confirmation pending

สถานะ: หยุดรอการยืนยันจากอีกฝ่าย

## ค่าที่เสนอ

```env
OPENHANDS_LLM_MODEL=qwen3.6
OPENHANDS_LLM_BASE_URL=<Tesseract OpenAI-compatible base URL>
OPENHANDS_LLM_API_KEY=<server-side key>
```

## สิ่งที่ยังต้องยืนยัน

- URL ต้องเป็น endpoint แบบ OpenAI-compatible ที่ใช้งานได้จริง
- `qwen3.6` ต้องเป็นชื่อโมเดลที่ Tesseract เปิดให้เรียกใช้
- API key ต้องตั้งใน `.env` หรือ Docker secret ฝั่ง server เท่านั้น
- ห้ามบันทึก API key จริงลง Git หรือส่งเข้า client bundle

## ขั้นตอนหลังได้รับการยืนยัน

```powershell
docker compose --profile full up -d openhands web
```

จากนั้นตรวจ health/readiness และรัน OpenHands live smoke ใน task-bound worktree
ก่อนอนุมัติ P7-T4

ยังไม่มีการตั้งค่า secret จริง ไม่มีการ deploy และไม่มีการ approve P7-T4
