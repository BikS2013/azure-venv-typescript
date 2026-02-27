I want to create a typescript library, to be loaded when an application is starting, to link an azure blob storage folder as folder of the hosting app. 
I want to use this folder to load resources used by the application, like environment settings, documents, text resources etc. 
So when the hosting app is starting it must read the local .env file and any enviroment variables exported by the operating system. 
If among these settings found the AZURE_VENV variable and the AZURE_VENV_SAS_TOKEN the library must use them to attach the Azure blob storage folder pointed by the AZURE_VENV to the root folder of the hosting application.
Which means that all the files and folders under the AZURE_VENV folder must appear as files and folders under the hosting application. 
If between the files in the AZURE_VENV folder there is a .env file it must be consider and treated as an environment variables file, and all the settings from this file to be loaded to the app environment variables space before other actions take place, to allow these variables to be used by the operations. 



/team-workflow
I want you to review the implementation evaluate it according to the following design decissions, and investigate, design and implement any changes or additions needed, to fulfill them.
**Description:** The following design questions from plan-001 need resolution before implementation begins:
1. Q - Should the library support watching for blob changes after initial sync (file watcher mode)?
   A - The answer is Yes, the library shall be configurable to support watching blob changes after the initial sync. 
2. Q - Should there be a CLI command to manually trigger re-sync?
   A - The answer is Yes, the library shall offer a cli option to allow the manual re-sync except of the automated re-sync
3. Q - Should the manifest file location be configurable or always at project root?
   A - the answer is always at project root 
4. Q - Should orphan file deletion (`deleteOrphans`) be supported in v1?
   A - The orphan files management is not part of the scope yet 
5. Q - What is the maximum blob size threshold for switching from `downloadToFile()` to streaming?
   A - The maximum blob size idealy must be configurable either through `local` environment variable, or through an environment variable retrieved by the .env file from the AZURE_VENV file space. 