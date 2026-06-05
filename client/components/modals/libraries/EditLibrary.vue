<template>
  <div class="w-full h-full md:px-4 py-2 mb-4">
    <div v-if="!pickingFor" class="w-full h-full md:py-4">
      <div class="flex flex-wrap md:flex-nowrap -mx-1 mb-2">
        <div class="w-2/5 md:w-72 px-1 py-1 md:py-0">
          <ui-dropdown v-model="mediaType" :items="mediaTypes" :label="$strings.LabelMediaType" :disabled="!isNew" small @input="changedMediaType" />
        </div>
        <div class="w-full md:grow px-1 py-1 md:py-0">
          <ui-text-input-with-label ref="nameInput" v-model="name" :label="$strings.LabelLibraryName" @blur="nameBlurred" />
        </div>
        <div class="w-1/5 md:w-18 px-1 py-1 md:py-0">
          <ui-media-icon-picker v-model="icon" :label="$strings.LabelIcon" @input="iconChanged" />
        </div>
        <div class="w-2/5 md:w-72 px-1 py-1 md:py-0">
          <ui-dropdown v-model="provider" :items="providers" :label="$strings.LabelMetadataProvider" small @input="formUpdated" />
        </div>
      </div>

      <div class="folders-container overflow-y-auto w-full py-2 mb-2">
        <p class="px-1 text-sm font-semibold">{{ $strings.LabelFolders }}</p>
        <div v-for="(folder, index) in folders" :key="index" class="w-full flex items-center py-1 px-2">
          <span class="material-symbols fill mr-2 text-yellow-200" style="font-size: 1.2rem">folder</span>
          <ui-editable-text ref="folderInput" v-model="folder.fullPath" :readonly="!!folder.id" type="text" class="w-full" @blur="existingFolderInputBlurred(folder)" />
          <span v-show="folders.length > 1" class="material-symbols text-2xl ml-2 cursor-pointer hover:text-error" @click="removeFolder(folder)">close</span>
        </div>
        <div class="flex py-1 px-2 items-center w-full">
          <span class="material-symbols fill mr-2 text-yellow-200" style="font-size: 1.2rem">folder</span>
          <ui-editable-text ref="newFolderInput" v-model="newFolderPath" :placeholder="$strings.PlaceholderNewFolderPath" type="text" class="w-full" @blur="newFolderInputBlurred" />
        </div>

        <ui-btn class="w-full mt-2" color="bg-primary" @click="browseForFolder">{{ $strings.ButtonBrowseForFolder }}</ui-btn>
      </div>

      <div v-if="mediaType === 'book'" class="w-full mt-4 pt-3 border-t border-white/10">
        <p class="px-1 text-sm font-semibold">Import folder</p>
        <p class="px-1 text-xs text-gray-400 mb-2">Ebooks dropped into this folder will be queued for admin review and can be matched to existing audiobooks. Requires Audiobooks Only mode. Must be outside every library folder.</p>
        <div class="flex items-center py-1 px-2">
          <ui-toggle-switch v-model="importFolderEnabled" size="sm" @input="formUpdated" />
          <p class="pl-3 text-sm">Watch import folder</p>
        </div>
        <div class="w-full flex items-center py-1 px-2">
          <span class="material-symbols fill mr-2 text-warning" style="font-size: 1.2rem">drive_folder_upload</span>
          <ui-editable-text ref="importFolderInput" v-model="importFolder" type="text" placeholder="/absolute/path/to/import" class="w-full" @blur="formUpdated" />
          <span v-show="importFolder" class="material-symbols text-2xl ml-2 cursor-pointer hover:text-error" @click="clearImportFolder">close</span>
        </div>
        <ui-btn class="w-full mt-2" color="bg-primary" @click="browseForImportFolder">{{ $strings.ButtonBrowseForFolder }}</ui-btn>
      </div>
    </div>
    <modals-libraries-lazy-folder-chooser v-else :paths="pickerExcludePaths" @back="cancelPicker" @select="selectFolder" />
  </div>
</template>

<script>
export default {
  props: {
    isNew: Boolean,
    library: {
      type: Object,
      default: () => null
    },
    processing: Boolean
  },
  data() {
    return {
      name: '',
      provider: 'google',
      icon: '',
      folders: [],
      pickingFor: null,
      newFolderPath: '',
      mediaType: null,
      importFolder: '',
      importFolderEnabled: false
    }
  },
  computed: {
    mediaTypes() {
      return [
        {
          value: 'book',
          text: this.$strings.LabelBooks
        },
        {
          value: 'podcast',
          text: this.$strings.LabelPodcasts
        }
      ]
    },
    folderPaths() {
      return this.folders.map((f) => f.fullPath)
    },
    pickerExcludePaths() {
      const merged = [...this.folderPaths]
      if (this.importFolder) merged.push(this.importFolder)
      return merged.filter(Boolean)
    },
    providers() {
      if (this.mediaType === 'podcast') return this.$store.state.scanners.podcastProviders
      return this.$store.state.scanners.bookProviders
    }
  },
  methods: {
    checkBlurExpressionInput() {
      if (this.$refs.nameInput) {
        this.$refs.nameInput.blur()
      }
      if (this.$refs.folderInput && this.$refs.folderInput.length) {
        this.$refs.folderInput.forEach((input) => {
          if (input.blur) input.blur()
        })
      }
      if (this.$refs.newFolderInput) {
        this.$refs.newFolderInput.blur()
      }
    },
    browseForFolder() {
      this.pickingFor = 'library'
    },
    browseForImportFolder() {
      this.pickingFor = 'import'
    },
    cancelPicker() {
      this.pickingFor = null
    },
    clearImportFolder() {
      this.importFolder = ''
      this.formUpdated()
    },
    getLibraryData() {
      const data = {
        name: this.name,
        provider: this.provider,
        folders: this.folders,
        icon: this.icon,
        mediaType: this.mediaType
      }
      // Only book libraries support import-folder watching
      if (this.mediaType === 'book') {
        data.settings = {
          importFolder: this.importFolder?.trim() ? this.importFolder.trim() : null,
          importFolderEnabled: !!this.importFolderEnabled
        }
      }
      return data
    },
    formUpdated() {
      this.$emit('update', this.getLibraryData())
    },
    existingFolderInputBlurred(folder) {
      if (!folder.fullPath) {
        this.removeFolder(folder)
      }
    },
    newFolderInputBlurred() {
      if (this.newFolderPath) {
        this.folders.push({ fullPath: this.newFolderPath })
        this.newFolderPath = ''
        this.formUpdated()
      }
    },
    iconChanged() {
      this.formUpdated()
    },
    nameBlurred() {
      if (this.name !== this.library.name) {
        this.formUpdated()
      }
    },
    changedMediaType() {
      this.provider = this.providers[0].value
      this.formUpdated()
    },
    selectFolder(fullPath) {
      if (this.pickingFor === 'import') {
        this.importFolder = fullPath
      } else {
        this.folders.push({ fullPath })
      }
      this.pickingFor = null
      this.formUpdated()
    },
    removeFolder(folder) {
      this.folders = this.folders.filter((f) => f.fullPath !== folder.fullPath)
      this.formUpdated()
    },
    backArrowPress() {
      if (this.pickingFor) {
        this.pickingFor = null
      }
    },
    init() {
      this.name = this.library ? this.library.name : ''
      this.provider = this.library ? this.library.provider : 'google'
      this.folders = this.library ? this.library.folders.map((p) => ({ ...p })) : []
      this.icon = this.library ? this.library.icon : 'default'
      this.mediaType = this.library ? this.library.mediaType : 'book'
      this.importFolder = this.library?.settings?.importFolder || ''
      this.importFolderEnabled = !!this.library?.settings?.importFolderEnabled

      this.pickingFor = null
    }
  },
  mounted() {
    this.init()
    // Fetch providers if not already loaded
    this.$store.dispatch('scanners/fetchProviders')
  }
}
</script>

<style>
.folders-container {
  max-height: calc(80vh - 192px);
}
@media (max-device-width: 768px) {
  .folders-container {
    max-height: calc(80vh - 292px);
  }
}
</style>
