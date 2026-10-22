I need to update the stills library for the Filmkraft and Screenbridge projects.

You should use the Extract_Stills (/Users/haroldfandino/Documents/Harold/Tools/extract-stills) and Rename_Stills (/Users/haroldfandino/Documents/Harold/Tools/postproduction-tools/Rename_stills) tools to accomplish this.

Here's the list of projects that need stills (are marked in the status column as To Do):

- Filmkraft: https://docs.google.com/spreadsheets/d/11kk_s8r-_dk1W3K8uudB1YtpMYh4LTlcHcFcq4O7Z6w/edit?usp=sharing
- Screenbridge: https://docs.google.com/spreadsheets/d/15sS9pdgUTTVZp8t298bCvBKy0gLNpTIULUNCHQM0364/edit?usp=sharing

The source is:

- Filmkraft: /Volumes/filmkraft/filespace/Filmkraft
- Screenbridge: /Volumes/filmkraft/filespace/Screenbridge

The destination is:

- Filmkraft: https://drive.google.com/open?id=1DQr_5OSdnZluCyACHdaSLoQsp2sOBp2S&usp=drive_fs
- Screenbridge: https://drive.google.com/open?id=1Pdz7dsMmzXGoF5Sx6-q8z1wEudvQDWCS&usp=drive_fs

# Workflow

- You select a project to work on the respective Google Sheets document. Change the status to In Process.
- Find the project folder in [source]:
	- E.g. for Filmkraft: /Volumes/filmkraft/filespace/Filmkraft/01_ActiveProjects/[1289]Net32_2026_Brand_Refresh
	- E.g. for Screenbridge:
	  /Volumes/filmkraft/filespace/Screenbridge/01_ActiveProjects/[203SB]Airwaav_Brager
	Then look for the client delivery folder; it usually has this format [Project folder]/11_FINAL_DELIVERY/01_Videos. There you'll find the videos, sometimes in the same folder or in an internal folder. If no video is found, please let the user know through the UI.
- Once the videos are identified, you'll extract the stills only from the videos with the highest duration the naming is like this Airwaav_Brager_30_4K_Social_H264. Where 30 is the duration, it can be 6, 15, 30 and long-form. In that order you'll find the longest duration being long-form the longest. Then you select whether Social or TV not both to select the video/videos for stills extraction. There can be multiple versions, and you should export stills for at least one video of the multiple version, e.g. you could find Airwaav_Brager-Offer_30_4K_Social_H264, Airwaav_Brager-NoOffer_30_4K_Social_H264, and Airwaav_Brager-Amazon_30_4K_Social_H264. The user will see all the videos you found, which ones you selected automatically, and will manually approve by checking/unchecking the videos that will have their stills extracted. Also, we need stills for Square, Vertical, 4x5, and horizontal versions when available, using the indications above.
- Once the video list is approved by the user, the still extraction starts using the Extract_Stills tool, exporting only the necessary PNG files. Finally, you rename the stills using the project naming tags, as you can see examples in the [destination] folders of stills from previous projects, using the rename_stills tool. The output of the stills is the [destination] folder you create or find for the current project.
- Once a human approves the stills (he can, prior to export, select/unselect some of the stills) from one project and those are copied into the [destination] folder, you continue with the next in the list. Some projects in the list can be skipped by the human.

# Architecture

Please, let me know how will you accomplish this. I want a electron app for Windows 11 and MacOS. With GUI and CLI. For this specific task I want you, the Agent to execute the steps, I'll suppervise those for every project.

The user should be able to open the folders in the explorer/finder from the GUI.

# Notes

Ask me questions. Let's test it initially for [203SB]Airwaav_Brager, then [1289]Net32_2026_Brand_Refresh. Once all works for these, we'll go through every project in the list. Those in state done; they don't need to be done, of course.

Never delete/change names/move anything from the folders; you can test things locally. But if something needs this action, please ask me to do it.