FROM node:lts

RUN mkdir -p /{config,app}/
WORKDIR /app

ADD package.json /app
ADD extract.js /app

RUN npm install

ENV SBFSPOT_CONFIG="/config/SBFspot.cfg"

CMD node extract.js $SBFSPOT_CONFIG
