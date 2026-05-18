import pymongo, os
client = pymongo.MongoClient(os.environ["MONGO_URL"])
db = client[os.environ["DB_NAME"]]
db.users.update_one({"email": "testagent@test.com"}, {"$set": {"agent_name": "Wes Lunt"}})
db.users.update_one({"email": "admin@grueninghw.com"}, {"$set": {"agent_name": "Matt Monacelli"}})
print("Done")
