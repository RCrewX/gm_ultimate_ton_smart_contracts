# Use Node.js 20 LTS as base image
FROM node:20-slim

# Install pnpm globally
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and configuration files
COPY . .

# Build the contracts
RUN pnpm build


