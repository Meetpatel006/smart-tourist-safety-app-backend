# Smart Tourist & Commuter Safety System - Backend

A comprehensive Node.js backend for a Smart Tourist Safety system that provides real-time safety monitoring, dynamic risk assessment, geofencing, SOS alerts, blockchain-backed audit trails, and tour group management.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [API Endpoints](#api-endpoints)

---

## Overview

The Smart Tourist & Commuter Safety System is a holistic platform bridging the gap between civilians and authorities. It's not just an SOS button; it's a proactive safety ecosystem that:

- **Proactively warns users** before they enter danger zones using a dynamic Risk Engine
- **Recognizes user hierarchy** (Solo Traveler vs. Tour Group Leader vs. Group Member)
- **Creates non-repudiable records** using blockchain technology for legal audit trails
- **Provides real-time monitoring** for authorities and group administrators
- **Enables group management** with virtual leash geofencing and headcount features

---

## Tech Stack

- **Runtime**: Node.js (v16+)
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Real-time**: Socket.IO (planned)
- **Blockchain**: Polygon (Ethereum L2) via Ethers.js
- **HTTP Logging**: Morgan
- **Application Logging**: Winston
- **Security**: bcryptjs, AES-256 encryption for PII

---

## Quick Start

### Requirements

- Node.js v16+
- MongoDB (local or cloud instance)
- npm or yarn

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file in the project root with the following:

```env
PORT=3000
DB_URL=mongodb://localhost:27017/tourist-safety
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRES_IN=7d
PRIVATE_KEY=your_ethereum_wallet_private_key
SMART_CONTRACT_ADDRESS_reg=your_registration_contract_address
SMART_CONTRACT_ADDRESS_sos=your_sos_contract_address
POLYGON_RPC=https://polygon-rpc.com
NODE_ENV=development
```

### Running the Application

**Development Mode** (with auto-reload):

```bash
npm run dev
```

**Production Mode**:

```bash
npm start
```

The server will start on `http://localhost:3000` (or the PORT specified in `.env`).

### Docker Deployment

**Build Docker Image**:

```bash
docker build -t tourist-backend:latest .
```

**Run with Docker Compose** (includes MongoDB):

```bash
docker-compose up --build
```

**Pull from Docker Hub**:

```bash
docker pull redrepter/tourist-backend:latest
docker run --rm -p 3000:3000 \
  -e DB_URL="mongodb://host:27017/tourist-safety" \
  --name tourist-backend \
  redrepter/tourist-backend:latest
```

---

## Architecture

### Project Structure

```
backend/
├── app.js                    # Application entry point
├── config/
│   ├── config.js            # Environment configuration
│   └── dbConnection.js      # MongoDB connection logic
├── controllers/             # Request handlers
│   ├── authController.js
│   ├── authorityController.js
│   ├── geofenceController.js
│   ├── incidentController.js
│   ├── itineraryController.js
│   ├── SOSalertController.js
│   ├── tourGroupController.js
│   ├── touristController.js
│   └── verifyController.js
├── middlewares/             # Authentication & error handling
│   ├── authMiddleware.js
│   └── errorMiddleware.js
├── models/                  # Mongoose schemas
│   ├── Authority.js
│   ├── Geofence.js
│   ├── Incident.js
│   ├── RiskGrid.js
│   ├── SOSalert.js
│   ├── TourGroup.js
│   └── Tourist.js
├── routes/                  # Route definitions
│   ├── authRoutes.js
│   ├── authorityRoutes.js
│   ├── geofenceRoutes.js
│   ├── incidentRoutes.js
│   ├── itineraryRoutes.js
│   ├── sosRoutes.js
│   ├── tourGroupRoutes.js
│   └── touristRoutes.js
├── services/                # Background services
│   ├── blockchainService.js
│   ├── fallbackService.js
│   ├── newsService.js
│   ├── realtimeService.js
│   └── riskEngineService.js
└── utils/                   # Utility functions
```

### Background Services

**Risk Engine**: Runs every 30 minutes to recalculate risk scores for geographic grids based on recent SOS alerts, incidents, and historical data.

**Blockchain Service**: Logs critical events (SOS alerts, registrations) to Polygon blockchain for immutable audit trails.

---

## API Endpoints

### Authentication (`/api/auth`)

#### `POST /api/auth/register`

Register a new tourist account.

**Request Body**:

```json
{
  "name": "John Doe",
  "govId": "ABC123456",
  "phone": "+1234567890",
  "email": "john@example.com",
  "password": "SecurePassword123",
  "emergencyContact": {
    "name": "Jane Doe",
    "phone": "+1234567891",
    "relation": "Spouse"
  },
  "dayWiseItinerary": [],
  "language": "en",
  "tripEndDate": "2026-12-31",
  "role": "solo",
  "consent": {
    "tracking": true,
    "dataRetention": true,
    "emergencySharing": true
  }
}
```

**Response** (200 OK):

```json
{
  "message": "Registered successfully.",
  "touristId": "507f1f77bcf86cd799439011",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "solo",
  "audit": {
    "blockchainTxHash": "0xabc123..."
  }
}
```

---

#### `POST /api/auth/login`

Authenticate a tourist and return an access token.

**Request Body**:

```json
{
  "email": "john@example.com",
  "password": "SecurePassword123"
}
```

**Response** (200 OK):

```json
{
  "message": "Login successful",
  "touristId": "507f1f77bcf86cd799439011",
  "role": "solo",
  "groupId": null,
  "ownedGroupId": null,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

#### `GET /api/auth/verify/:touristId`

Verify a tourist record by `touristId`.

**URL Parameters**:

- `touristId`: Tourist's MongoDB ID

**Response** (200 OK):

```json
{
  "success": true,
  "verified": true,
  "data": {
    "tourist": {
      "touristId": "507f1f77bcf86cd799439011",
      "name": "John Doe",
      "email": "john@example.com"
    }
  }
}
```

---

### Tourist (`/api/tourist`)

#### `GET /api/tourist/me`

Get authenticated tourist's profile.

**Headers**: `Authorization: Bearer <token>`

**Response** (200 OK):

```json
{
  "touristId": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "phone": "+1234567890",
  "email": "john@example.com",
  "dayWiseItinerary": [],
  "emergencyContact": {
    "name": "Jane Doe",
    "phone": "+1234567891",
    "relation": "Spouse"
  },
  "language": "en",
  "createdAt": "2026-01-15T10:30:00Z",
  "expiresAt": "2026-12-31T23:59:59Z",
  "audit": {}
}
```

---

#### `GET /api/tourist/`

Get list of all tourists (admin/public endpoint).

**Response** (200 OK):

```json
[
  {
    "touristId": "507f1f77bcf86cd799439011",
    "name": "John Doe",
    "email": "john@example.com"
  }
]
```

---

### SOS Alerts (`/api/sos`)

#### `POST /api/sos/trigger`

Trigger an SOS alert for the authenticated tourist.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "location": {
    "coordinates": [74.7973, 34.0837],
    "locationName": "Dal Lake, Srinagar"
  },
  "safetyScore": 0.25,
  "sosReason": {
    "reason": "Assault",
    "weatherInfo": "Clear",
    "extra": "Being followed by unknown person"
  }
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "SOS alert received. Authorities have been notified.",
  "sosAlert": {
    "id": "507f191e810c19729de860ea",
    "status": "active",
    "location": {
      "coordinates": [74.7973, 34.0837],
      "locationName": "Dal Lake, Srinagar"
    },
    "timestamp": "2026-01-26T11:25:00Z",
    "blockchainTxHash": "0xdef456..."
  }
}
```

---

### Incidents (`/api/incidents`)

#### `POST /api/incidents`

Report/create a new incident (crowdsourced incident reporting).

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "title": "Theft Incident Near Market",
  "type": "theft",
  "latitude": 34.0837,
  "longitude": 74.7973,
  "severity": 0.7
}
```

**Valid Types**: `theft`, `assault`, `accident`, `riot`, `natural_disaster`, `other`

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Incident reported successfully.",
  "data": {
    "incident": {
      "id": "507f191e810c19729de860eb",
      "title": "Theft Incident Near Market",
      "type": "theft",
      "location": {
        "type": "Point",
        "coordinates": [74.7973, 34.0837]
      },
      "severity": 0.7,
      "timestamp": "2026-01-26T11:25:00Z"
    }
  }
}
```

---

### Geofence & Danger Zones (`/api/geofence`)

#### `GET /api/geofence/`

Get list of all geofence zones (static danger zones).

**Response** (200 OK):

```json
[
  {
    "_id": "507f191e810c19729de860ec",
    "name": "High Crime Area - Downtown",
    "riskLevel": "High",
    "center": [74.7973, 34.0837],
    "radius": 500,
    "metadata": {
      "source": "Police",
      "category": "Crime"
    }
  }
]
```

---

#### `GET /api/geofence/count`

Get count of high-risk zones.

**Response** (200 OK):

```json
{
  "success": true,
  "highRiskZones": 12
}
```

---

#### `GET /api/geofence/dynamic`

Get dynamic risk zones (calculated by Risk Engine).

**Query Parameters** (optional):

- `lat`: Latitude (e.g., 34.0837)
- `lng`: Longitude (e.g., 74.7973)
- `radius`: Radius in meters (e.g., 5000)

**Response** (200 OK) - GeoJSON FeatureCollection:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "gridId": "34.08425_74.79775",
        "riskScore": 0.75,
        "riskLevel": "High",
        "gridName": "Dal Lake Area",
        "lastUpdated": "2026-01-26T11:00:00Z"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [74.79775, 34.08425]
      }
    }
  ]
}
```

---

#### `POST /api/geofence/zone`

Create a static geofence/danger zone.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "name": "Construction Zone",
  "center": [74.7973, 34.0837],
  "radius": 300,
  "riskLevel": "Medium",
  "metadata": {
    "source": "Municipal",
    "category": "Infrastructure"
  }
}
```

**Response** (200 OK):

```json
{
  "message": "Danger zone saved successfully",
  "data": {
    "zone": {
      "_id": "507f191e810c19729de860ed",
      "name": "Construction Zone",
      "riskLevel": "Medium"
    }
  }
}
```

---

#### `POST /api/geofence/transitions`

Receive geofence transition events from client.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "transitions": [
    {
      "digitalId": "TOURIST_123",
      "touristId": "507f1f77bcf86cd799439011",
      "zoneId": "507f191e810c19729de860ec",
      "eventType": "ENTER",
      "timestamp": "2026-01-26T11:25:00Z",
      "location": {
        "latitude": 34.0837,
        "longitude": 74.7973,
        "locationName": "Dal Lake"
      }
    }
  ]
}
```

**Response** (200 OK):

```json
{
  "message": "Geofence transitions received successfully.",
  "insertedCount": 1,
  "alerts": []
}
```

---

#### `POST /api/geofence/risk/update`

Trigger a manual risk update calculation (admin/service endpoint).

**Response** (200 OK):

```json
{
  "message": "Risk scores updated successfully."
}
```

---

#### `GET /api/geofence/:id`

Get details for a single zone by ID.

**Headers**: `Authorization: Bearer <token>`

**URL Parameters**:

- `id`: Zone MongoDB ID

**Response** (200 OK):

```json
{
  "zone": {
    "_id": "507f191e810c19729de860ec",
    "name": "High Crime Area - Downtown",
    "riskLevel": "High",
    "center": [74.7973, 34.0837],
    "radius": 500
  }
}
```

---

### Tour Group Management (`/api/group`)

#### `POST /api/group/create`

Create a new tour group (Tour Admin feature).

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "groupName": "Kashmir Adventure Group 2026",
  "startDate": "2026-02-01",
  "endDate": "2026-02-10",
  "itinerary": [
    {
      "date": "2026-02-01",
      "dayNumber": 1,
      "nodes": [
        {
          "type": "hotel",
          "name": "Grand Palace Hotel",
          "location": {
            "coordinates": [74.7973, 34.0837]
          }
        }
      ]
    }
  ]
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Group created successfully",
  "data": {
    "groupId": "507f191e810c19729de860ee",
    "accessCode": "KASHMIR2026",
    "groupName": "Kashmir Adventure Group 2026"
  }
}
```

---

#### `POST /api/group/join`

Join an existing tour group.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "accessCode": "KASHMIR2026"
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Joined group: Kashmir Adventure Group 2026",
  "data": {
    "groupId": "507f191e810c19729de860ee",
    "groupName": "Kashmir Adventure Group 2026"
  }
}
```

---

#### `GET /api/group/dashboard`

Get dashboard/summary info for the authenticated user's group.

**Headers**: `Authorization: Bearer <token>`

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "group": {
      "groupId": "507f191e810c19729de860ee",
      "groupName": "Kashmir Adventure Group 2026",
      "adminId": "507f1f77bcf86cd799439011",
      "members": [
        {
          "touristId": "507f1f77bcf86cd799439012",
          "name": "Alice Smith"
        }
      ],
      "itinerary": [],
      "startDate": "2026-02-01",
      "endDate": "2026-02-10"
    }
  }
}
```

---

#### `PUT /api/group/update`

Update group itinerary (Tour Admin only).

**Headers**: `Authorization: Bearer <token>`

**Request Body**:

```json
{
  "itinerary": [
    {
      "date": "2026-02-02",
      "dayNumber": 2,
      "nodes": [
        {
          "type": "attraction",
          "name": "Mughal Gardens",
          "location": {
            "coordinates": [74.8723, 34.0912]
          }
        }
      ]
    }
  ]
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Itinerary updated successfully",
  "data": {
    "groupId": "507f191e810c19729de860ee",
    "itinerary": []
  }
}
```

---

### Group Member Management (`/api/group/members`)

All group member routes require authentication and Tour Admin role.

#### `GET /api/group/members`

Get all members in the tour group with optional filters.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**Query Parameters** (optional):

- `status`: Filter by member status (e.g., 'active', 'inactive')
- `name`: Filter by member name (partial match)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "members": [
      {
        "_id": "507f191e810c19729de860f1",
        "name": "Alice Smith",
        "email": "alice@example.com",
        "phone": "+1234567892",
        "status": "active",
        "joinedAt": "2026-02-01T10:00:00Z"
      }
    ],
    "count": 1
  }
}
```

---

#### `POST /api/group/members`

Add a new member to the tour group.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**Request Body**:

```json
{
  "name": "Bob Johnson",
  "email": "bob@example.com",
  "phone": "+1234567893",
  "emergencyContact": {
    "name": "Mary Johnson",
    "phone": "+1234567894",
    "relation": "Spouse"
  }
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Member added successfully",
  "data": {
    "member": {
      "_id": "507f191e810c19729de860f2",
      "name": "Bob Johnson",
      "email": "bob@example.com",
      "status": "active"
    }
  }
}
```

---

#### `POST /api/group/members/bulk`

Bulk add multiple members to the tour group.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**Request Body**:

```json
{
  "members": [
    {
      "name": "Charlie Brown",
      "email": "charlie@example.com",
      "phone": "+1234567894"
    },
    {
      "name": "Diana Prince",
      "email": "diana@example.com",
      "phone": "+1234567895"
    }
  ]
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "2 members added successfully",
  "data": {
    "addedCount": 2,
    "members": [
      {
        "_id": "507f191e810c19729de860f3",
        "name": "Charlie Brown",
        "email": "charlie@example.com"
      },
      {
        "_id": "507f191e810c19729de860f4",
        "name": "Diana Prince",
        "email": "diana@example.com"
      }
    ]
  }
}
```

---

#### `POST /api/group/members/send-welcome-all`

Send welcome emails to all members in the tour group.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Welcome emails sent to all members",
  "data": {
    "emailsSent": 5
  }
}
```

---

#### `GET /api/group/members/:memberId`

Get details of a single member by ID.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**URL Parameters**:

- `memberId`: Member's MongoDB ID

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "member": {
      "_id": "507f191e810c19729de860f1",
      "name": "Alice Smith",
      "email": "alice@example.com",
      "phone": "+1234567892",
      "emergencyContact": {
        "name": "John Smith",
        "phone": "+1234567896",
        "relation": "Father"
      },
      "status": "active",
      "joinedAt": "2026-02-01T10:00:00Z"
    }
  }
}
```

---

#### `PUT /api/group/members/:memberId`

Update member information.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**URL Parameters**:

- `memberId`: Member's MongoDB ID

**Request Body**:

```json
{
  "name": "Alice Johnson",
  "phone": "+1234567897",
  "status": "active",
  "emergencyContact": {
    "name": "Jane Smith",
    "phone": "+1234567898",
    "relation": "Mother"
  }
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Member updated successfully",
  "data": {
    "member": {
      "_id": "507f191e810c19729de860f1",
      "name": "Alice Johnson",
      "phone": "+1234567897",
      "status": "active"
    }
  }
}
```

---

#### `DELETE /api/group/members/:memberId`

Remove a member from the tour group.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isTourAdmin` role

**URL Parameters**:

- `memberId`: Member's MongoDB ID

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Member removed successfully",
  "data": {
    "removedMemberId": "507f191e810c19729de860f1"
  }
}
```

---

### Itinerary Management (`/api/itinerary`)

#### `GET /api/itinerary/`

Get logged-in user's itinerary (solo travelers only).

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isSolo` role

**Response** (200 OK):

```json
{
  "success": true,
  "data": [
    {
      "date": "2026-02-01",
      "dayNumber": 1,
      "nodes": [
        {
          "type": "hotel",
          "name": "Grand Palace Hotel",
          "location": {
            "coordinates": [74.7973, 34.0837]
          }
        }
      ]
    }
  ]
}
```

---

#### `POST /api/itinerary/:id`

Create itinerary for tourist identified by `id` (only if none exists).

**URL Parameters**:

- `id`: Tourist ID

**Request Body**:

```json
{
  "itinerary": [
    {
      "date": "2026-02-01",
      "dayNumber": 1,
      "nodes": [
        {
          "type": "hotel",
          "name": "Grand Palace Hotel",
          "location": {
            "coordinates": [74.7973, 34.0837]
          }
        }
      ]
    }
  ]
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Itinerary created",
  "data": []
}
```

---

#### `PUT /api/itinerary/`

Replace entire itinerary for authenticated user (solo travelers only).

**Headers**: `Authorization: Bearer <token>`

**Request Body**: Same as POST above

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Itinerary saved",
  "data": []
}
```

---

#### `PUT /api/itinerary/day/:dayNumber`

Upsert a single day in authenticated user's itinerary.

**Headers**: `Authorization: Bearer <token>`

**URL Parameters**:

- `dayNumber`: Day number (e.g., 1, 2, 3)

**Request Body**:

```json
{
  "day": {
    "date": "2026-02-01",
    "nodes": [
      {
        "type": "restaurant",
        "name": "Kashmiri Delights",
        "location": {
          "coordinates": [74.8012, 34.085]
        }
      }
    ]
  }
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Day updated",
  "data": []
}
```

---

#### `DELETE /api/itinerary/`

Clear authenticated user's itinerary.

**Headers**: `Authorization: Bearer <token>`

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Itinerary cleared"
}
```

---

### Authority Dashboard (`/api/authority`)

#### `POST /api/authority/signup`

Register a new authority account.

**Request Body**:

```json
{
  "name": "Officer Smith",
  "email": "smith@police.gov",
  "password": "SecurePassword123",
  "departmentName": "Tourist Police",
  "badgeNumber": "TP12345"
}
```

**Response** (201 Created):

```json
{
  "message": "Authority registered successfully",
  "authorityId": "507f191e810c19729de860ef",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

#### `POST /api/authority/login`

Authenticate an authority user.

**Request Body**:

```json
{
  "email": "smith@police.gov",
  "password": "SecurePassword123"
}
```

**Response** (200 OK):

```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "authority"
}
```

---

#### `GET /api/authority/me`

Get authenticated authority's profile.

**Headers**: `Authorization: Bearer <token>`

**Response** (200 OK):

```json
{
  "authorityId": "507f191e810c19729de860ef",
  "name": "Officer Smith",
  "email": "smith@police.gov",
  "departmentName": "Tourist Police",
  "badgeNumber": "TP12345"
}
```

---

#### `GET /api/authority/dashboard-stats`

Get dashboard statistics for authorities.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isAuthority` role

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "activeSOS": 3,
    "totalTourists": 1250,
    "highRiskZones": 12,
    "resolvedIncidents": 45
  }
}
```

---

#### `GET /api/authority/alerts`

Get new/active SOS alerts.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isAuthority` role

**Response** (200 OK):

```json
{
  "success": true,
  "alerts": [
    {
      "_id": "507f191e810c19729de860ea",
      "touristId": "507f1f77bcf86cd799439011",
      "location": {
        "coordinates": [74.7973, 34.0837],
        "locationName": "Dal Lake"
      },
      "status": "active",
      "timestamp": "2026-01-26T11:25:00Z"
    }
  ]
}
```

---

#### `PUT /api/authority/alerts/:id/assign`

Assign a response unit to an SOS alert.

**Headers**: `Authorization: Bearer <token>`

**URL Parameters**:

- `id`: SOS Alert ID

**Request Body**:

```json
{
  "unitId": "UNIT-123",
  "unitType": "Police Patrol"
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Unit assigned to alert",
  "alert": {
    "_id": "507f191e810c19729de860ea",
    "assignedUnit": "UNIT-123"
  }
}
```

---

#### `GET /api/authority/tourist-management`

Get tourist management data.

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isAuthority` role

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "tourists": [],
    "groups": []
  }
}
```

---

#### `GET /api/authority/map-overview`

Get map overview data (tourist locations, zones, etc.).

**Headers**: `Authorization: Bearer <token>`

**Middleware**: Requires `isAuthority` role

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "touristLocations": [],
    "dangerZones": [],
    "activeAlerts": []
  }
}
```

---

#### `DELETE /api/authority/revoke/:id`

Revoke/delete a tourist account (admin action).

**Headers**: `Authorization: Bearer <token>`

**URL Parameters**:

- `id`: Tourist ID

**Response** (200 OK):

```json
{
  "success": true,
  "message": "Tourist account revoked"
}
```

---

#### `GET /api/authority/count`

Get SOS counts and statistics.

**Response** (200 OK):

```json
{
  "success": true,
  "totalSOS": 156,
  "activeSOS": 3,
  "resolvedSOS": 153
}
```

---

## Documentation References

- [API_CONTRACT.md](./API_CONTRACT.md) - Detailed API specifications
- [FINAL_SRS.md](./FINAL_SRS.md) - Software Requirements Specification
- [System_Improvement_Plan.txt](./System_Improvement_Plan.txt) - Planned features
- [dynamic-danger-zone.md](./dynamic-danger-zone.md) - Risk Engine implementation guide
- [FRONTEND_IMPLEMENTATION_GUIDE.md](./FRONTEND_IMPLEMENTATION_GUIDE.md) - Frontend integration guide

---

## Support & Contributing

**Issues**: Report bugs or request features via GitHub Issues

**Contributing**:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is part of an academic initiative for Smart City Safety solutions.

---

**Built with ❤️ for Tourist Safety**
