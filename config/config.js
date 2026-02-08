const {config} = require("dotenv");

config({path : `.env`});

module.exports = {
    PORT,
    MONGO_URI,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    POLYGON_RPC,
    SMART_CONTRACT_ADDRESS,
    SMART_CONTRACT_ADDRESS_reg,
    SMART_CONTRACT_ADDRESS_sos,
    PRIVATE_KEY,
    SERVER_URL,
    GOVID_SALT,
    ENCRYPTION_KEY,
    MAPBOX_ACCESS_TOKEN,
    RESEND_API_KEY,
    FROM_EMAIL,
    REDIS_PORT,
    REDIS_HOST
} = process.env;
